#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import LambdaLayerPipelineStack from '../lib/pipeline-stack';

const app = new cdk.App();

/**
 * layerPrincipal: An account ID, or * to grant layer usage permission to all accounts in an organization,
 * or all Amazon Web Services accounts (if organizationId is not specified).
 * For the last case, make sure that you really do want all Amazon Web Services accounts to have usage permission to this layer.
 *
 * regionsToDistribute: The region code where the Lambda Layer will be distributed to.
 * See https://docs.aws.amazon.com/en_en/AWSEC2/latest/UserGuide/using-regions-availability-zones.html
 */
new LambdaLayerPipelineStack(app, 'LambdaLayerPipelineStack', {
  regionCodesToDistribute: ['eu-central-1', 'eu-west-1', 'us-west-1', 'us-east-1'],
  layerPrincipal: cdk.Aws.ACCOUNT_ID,
  organizationId: '',
  description: 'CodePipeline to build and distribute AWS Lambda layers across the specifcied region codes (uksb-1tupboc28)'
});
