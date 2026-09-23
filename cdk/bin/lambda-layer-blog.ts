#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import LambdaLayerPipelineStack from '../lib/pipeline-stack';

const app = new cdk.App();

/**
 * layerPrincipal: An AWS account ID to grant layer usage permission to.
 * For organization-wide sharing, set this to '*' and provide organizationId.
 * A wildcard principal without an organization ID is rejected by the stack.
 *
 * regionsToDistribute: The region codes where the Lambda layer will be distributed.
 * See https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html
 */
new LambdaLayerPipelineStack(app, 'LambdaLayerPipelineStack', {
  regionCodesToDistribute: ['eu-central-1', 'eu-west-1', 'us-west-1', 'us-east-1'],
  layerPrincipal: cdk.Aws.ACCOUNT_ID,
  organizationId: '',
  description: 'CodePipeline to build and distribute AWS Lambda layers across the specifcied region codes (uksb-1tupboc28)'
});
