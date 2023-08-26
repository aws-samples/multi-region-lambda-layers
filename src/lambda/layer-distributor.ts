// aws-sdk dependencies are provided with the Lambda runtime
import { LambdaClient, PublishLayerVersionCommand, AddLayerVersionPermissionCommand } from "@aws-sdk/client-lambda";
import { CodePipelineClient, PutJobSuccessResultCommand, PutJobFailureResultCommand } from "@aws-sdk/client-codepipeline"; // ES Modules import
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client();
const codepipeline = new CodePipelineClient();

export async function handler(event: any) {
  console.log('Received event ', JSON.stringify(event));

  // Extract data from input
  const jobId = event['CodePipeline.job'].id;
  const { location } = event['CodePipeline.job'].data.inputArtifacts[0];
  // The user parameters are passed as a single string
  const { region, layerPrincipal, organizationId } = JSON.parse(event['CodePipeline.job'].data.actionConfiguration.configuration.UserParameters);

  // Download layer
  const getObjectCommand = new GetObjectCommand({
    Bucket: location.s3Location.bucketName,
    Key: location.s3Location.objectKey
  });
  const getObjectCommandResult = await s3.send(getObjectCommand)
  const layerZip = await getObjectCommandResult.Body?.transformToByteArray();

  const layerParams = {
    Content: {
      ZipFile: layerZip
    },
    LayerName: 'sample-layer',
    CompatibleRuntimes: ['nodejs12.x', 'nodejs14.x'],
    Description: 'Sample layer distributed to multiple region by CodePipeline',
    LicenseInfo: 'MIT'
  };
  try {
    // Create Lambda client for the specified region
    const lambda = new LambdaClient({ region });
    const command = new PublishLayerVersionCommand(layerParams);
    const layer = await lambda.send(command);;
    console.log('Layer created: ', layer);
    if (layer.Version) {
      const layerPermissionsCommand = new AddLayerVersionPermissionCommand({
        Action: 'lambda:GetLayerVersion',
        LayerName: layerParams.LayerName,
        Principal: layerPrincipal,
        StatementId: 'layer-policy',
        VersionNumber: layer.Version,
        ...(organizationId && { OrganizationId: organizationId }),
      });
      const layerPermissions = await lambda.send(layerPermissionsCommand);
      console.log('Permissions applied: ', layerPermissions);
    }
  } catch (err) {
    console.error(err);
    // Inform CodePipeline about the failure
    const params = {
      failureDetails: {
        message: 'Layer distribution failed. Please check CloudWatch logs',
        type: 'JobFailed'
      },
      jobId
    };
    const command = new PutJobFailureResultCommand(params);
    return await codepipeline.send(command);
  }
  const command = new PutJobSuccessResultCommand({ jobId });
  return await codepipeline.send(command);
}
