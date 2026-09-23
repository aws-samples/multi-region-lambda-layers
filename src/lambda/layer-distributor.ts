// aws-sdk dependencies are provided with the Lambda runtime
import {
  LambdaClient, PublishLayerVersionCommand, AddLayerVersionPermissionCommand, Runtime,
} from "@aws-sdk/client-lambda";
import {
  CodePipelineClient, PutJobSuccessResultCommand, PutJobFailureResultCommand, FailureType,
} from "@aws-sdk/client-codepipeline";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client();
const codepipeline = new CodePipelineClient();
const layerName = 'sample-layer';
const regionPattern = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const accountIdPattern = /^\d{12}$/;
const organizationIdPattern = /^o-[a-z0-9]{10,32}$/;

type RecordValue = Record<string, unknown>;

interface DeploymentConfiguration {
  allowedRegions: string[];
  layerPrincipal: string;
  organizationId?: string;
}

interface DistributionInput {
  jobId: string;
  bucketName: string;
  objectKey: string;
  region: string;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null;
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : requiredString(value, 'optional value');
}

function getJobId(event: unknown): string | undefined {
  if (!isRecord(event) || !isRecord(event['CodePipeline.job'])) {
    return undefined;
  }
  const jobId = event['CodePipeline.job'].id;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : undefined;
}

function getDeploymentConfiguration(): DeploymentConfiguration {
  const allowedRegions = requiredString(process.env.ALLOWED_REGIONS, 'configured regions').split(',');
  if (allowedRegions.length === 0
    || allowedRegions.some((region) => !regionPattern.test(region))) {
    throw new Error('Invalid configured region allowlist');
  }

  const layerPrincipal = requiredString(process.env.LAYER_PRINCIPAL, 'configured layer principal');
  const organizationId = optionalString(process.env.ORGANIZATION_ID);
  if (layerPrincipal === '*' && !organizationId) {
    throw new Error('A wildcard layer principal requires an organization');
  }
  if (organizationId && !organizationIdPattern.test(organizationId)) {
    throw new Error('Invalid configured organization ID');
  }
  if (organizationId && layerPrincipal !== '*') {
    throw new Error('An organization ID requires a wildcard layer principal');
  }
  if (layerPrincipal !== '*' && !accountIdPattern.test(layerPrincipal)) {
    throw new Error('Invalid configured layer principal');
  }

  return { allowedRegions, layerPrincipal, organizationId };
}

function parseDistributionInput(event: unknown, allowedRegions: string[]): DistributionInput {
  if (!isRecord(event) || !isRecord(event['CodePipeline.job'])) {
    throw new Error('Invalid CodePipeline event');
  }

  const job = event['CodePipeline.job'];
  if (!isRecord(job.data) || !Array.isArray(job.data.inputArtifacts) || job.data.inputArtifacts.length === 0) {
    throw new Error('Missing input artifact');
  }

  const artifact = job.data.inputArtifacts[0];
  if (!isRecord(artifact) || !isRecord(artifact.location) || !isRecord(artifact.location.s3Location)) {
    throw new Error('Invalid input artifact location');
  }

  const s3Location = artifact.location.s3Location;
  const bucketName = requiredString(s3Location.bucketName, 'artifact bucket');
  const objectKey = requiredString(s3Location.objectKey, 'artifact key');

  if (!isRecord(job.data.actionConfiguration)
    || !isRecord(job.data.actionConfiguration.configuration)) {
    throw new Error('Missing action configuration');
  }
  const userParameters = requiredString(
    job.data.actionConfiguration.configuration.UserParameters,
    'user parameters',
  );

  let parameters: unknown;
  try {
    parameters = JSON.parse(userParameters);
  } catch {
    throw new Error('Invalid user parameters');
  }
  if (!isRecord(parameters)) {
    throw new Error('Invalid user parameters');
  }

  const region = requiredString(parameters.region, 'region');
  if (!regionPattern.test(region) || !allowedRegions.includes(region)) {
    throw new Error('Region is not in the configured allowlist');
  }

  return {
    jobId: requiredString(job.id, 'job ID'),
    bucketName,
    objectKey,
    region,
  };
}

async function reportFailure(jobId: string | undefined): Promise<unknown> {
  if (!jobId) {
    throw new Error('CodePipeline job ID is unavailable');
  }

  return codepipeline.send(new PutJobFailureResultCommand({
    failureDetails: {
      message: 'Layer distribution failed. Please check CloudWatch logs',
      type: FailureType.JobFailed,
    },
    jobId,
  }));
}

export async function handler(event: unknown): Promise<unknown> {
  const jobId = getJobId(event);

  try {
    const configuration = getDeploymentConfiguration();
    const input = parseDistributionInput(event, configuration.allowedRegions);
    const getObjectCommandResult = await s3.send(new GetObjectCommand({
      Bucket: input.bucketName,
      Key: input.objectKey,
    }));
    if (!getObjectCommandResult.Body) {
      throw new Error('Layer artifact is empty');
    }
    const layerZip = await getObjectCommandResult.Body.transformToByteArray();
    if (layerZip.length === 0) {
      throw new Error('Layer artifact is empty');
    }

    const lambda = new LambdaClient({ region: input.region });
    const layer = await lambda.send(new PublishLayerVersionCommand({
      Content: { ZipFile: layerZip },
      LayerName: layerName,
      CompatibleRuntimes: [Runtime.nodejs22x, Runtime.nodejs24x] as Runtime[],
      Description: 'Sample layer distributed to multiple regions by CodePipeline',
      LicenseInfo: 'MIT',
    }));
    if (layer.Version === undefined) {
      throw new Error('Layer version was not returned');
    }

    await lambda.send(new AddLayerVersionPermissionCommand({
      Action: 'lambda:GetLayerVersion',
      LayerName: layerName,
      Principal: configuration.layerPrincipal,
      StatementId: 'layer-policy',
      VersionNumber: layer.Version,
      ...(configuration.organizationId && { OrganizationId: configuration.organizationId }),
    }));

    console.log('Layer distribution completed', { jobId: input.jobId, region: input.region });
    return await codepipeline.send(new PutJobSuccessResultCommand({ jobId: input.jobId }));
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.error('Layer distribution failed', { jobId, errorName });
    return await reportFailure(jobId);
  }
}
