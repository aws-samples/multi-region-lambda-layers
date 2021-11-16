// aws-sdk dependencies are provided with the Lambda runtime
import { CodePipeline, Lambda, S3 } from 'aws-sdk';

const s3 = new S3();
const codepipeline = new CodePipeline();

export async function handler(event: any) {
  console.log('Received event ', JSON.stringify(event));

  // Extract data from input
  const jobId = event['CodePipeline.job'].id;
  const { location } = event['CodePipeline.job'].data.inputArtifacts[0];
  // The user parameters are passed as a single string
  const { region, layerPrincipal, organizationId } = JSON.parse(event['CodePipeline.job'].data.actionConfiguration.configuration.UserParameters);

  // Download layer
  const layerZip = await s3.getObject({
    Bucket: location.s3Location.bucketName,
    Key: location.s3Location.objectKey
  }).promise();

  const layerParams = {
    Content: {
      ZipFile: layerZip.Body
    },
    LayerName: 'sample-layer',
    CompatibleRuntimes: ['nodejs12.x', 'nodejs14.x'],
    Description: 'Sample layer distributed to multiple region by CodePipeline',
    LicenseInfo: 'MIT'
  };
  try {
    // Create Lambda client for the specified region
    const lambda = new Lambda({ region });
    const layer = await lambda.publishLayerVersion(layerParams).promise();
    console.log('Layer created: ', layer);
    if (layer.Version) {
      const layerPermissions = await lambda.addLayerVersionPermission({
        Action: 'lambda:GetLayerVersion',
        LayerName: layerParams.LayerName,
        Principal: layerPrincipal,
        StatementId: 'layer-policy',
        VersionNumber: layer.Version,
        ...(organizationId && { OrganizationId: organizationId }),
      }).promise();
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
    return codepipeline.putJobFailureResult(params).promise();
  }
  // Notify CodePipeline of a successful job
  return codepipeline.putJobSuccessResult({ jobId }).promise();
}
