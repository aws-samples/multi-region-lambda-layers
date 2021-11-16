import { Construct, Duration, Stack, StackProps } from '@aws-cdk/core';
import * as codebuild from '@aws-cdk/aws-codebuild';
import * as codecommit from '@aws-cdk/aws-codecommit';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as codepipelineActions from '@aws-cdk/aws-codepipeline-actions';
import * as iam from '@aws-cdk/aws-iam';
import { Asset } from '@aws-cdk/aws-s3-assets';
import { NodejsFunction } from '@aws-cdk/aws-lambda-nodejs';
import path = require('path');

interface LambdaLayerPipelineStackProps extends StackProps {
  regionCodesToDistribute: string[],
  layerPrincipal: string,
  organizationId?: string,
}

export default class LambdaLayerPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: LambdaLayerPipelineStackProps) {
    super(scope, id, props);

    // This repository will be used as the source for the layer content
    const repository = this.createRepository();

    const project = this.createCodeBuild();

    const sourceOutput = new codepipeline.Artifact();
    const sourceAction = new codepipelineActions.CodeCommitSourceAction({
      actionName: 'CodeCommit',
      repository,
      branch: 'main',
      output: sourceOutput,
    });

    const buildOutput = new codepipeline.Artifact();
    const buildAction = new codepipelineActions.CodeBuildAction({
      actionName: 'CodeBuild',
      project,
      input: sourceOutput,
      outputs: [buildOutput]
    });

    const layerUpdaterRole = this.createLambdaRole();

    const distributor = new NodejsFunction(this, 'LayerDistributor', {
      entry: '../src/lambda/layer-distributor.ts',
      role: layerUpdaterRole,
      functionName: 'LambdaLayerDistributor',
      description: 'Distributes Lambda layers into multiple regions from a single ZIP archive.',
      timeout: Duration.seconds(15),
      memorySize: 512,
    });
    // Create action per specified region
    const parallel = props.regionCodesToDistribute.map((region) => new codepipelineActions.LambdaInvokeAction({
      actionName: `distribute-${region}`,
      lambda: distributor,
      inputs: [buildOutput],
      userParameters: { region, layerPrincipal: props.layerPrincipal, organizationId: props.organizationId }
    }));

    new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'LambdaLayerBuilderPipeline',
      crossAccountKeys: false,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction]
        },
        {
          stageName: 'Build',
          actions: [buildAction]
        },
        {
          stageName: 'Distribute',
          actions: parallel,
        }
      ]
    });
  }

  /**
   * @returns a CodeCommit repository initialized with a basic package.json
   */
  private createRepository() {
    // Upload sample files
    const asset = new Asset(this, 'SampleAsset', {
      path: path.join(__dirname, '..', '/res'),
    });

    const cfnRepository = new codecommit.CfnRepository(this, 'LambdaLayerSource', {
      repositoryName: 'lambda-layer-source',
      repositoryDescription: 'Contains the source code for a nodejs12+14 Lambda layer.',
      // This initializes the main branch with source code from S3
      code: {
        branchName: 'main',
        s3: {
          bucket: asset.s3BucketName,
          key: asset.s3ObjectKey
        }
      },
    });

    return codecommit.Repository.fromRepositoryArn(this, 'LambdaLayerSourceRepo', cfnRepository.attrArn);
  }

  /**
   * @returns a Lambda execution role with all necessary permissions
   */
  private createLambdaRole() {
    // Permissions to publish new layer versions and add permissions
    const layerUpdaterRole = new iam.Role(this, 'LayerUpdaterRrole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        PublishLambdaLayer: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              resources: [`arn:aws:lambda:*:${this.account}:layer:*`, `arn:aws:lambda:*:${this.account}:layer:*:*`],
              actions: ['lambda:PublishLayerVersion', 'lambda:AddLayerVersionPermission'],
              effect: iam.Effect.ALLOW,
            }),
          ],
        })
      }
    });
    // Attach basic lambda execution permissions
    layerUpdaterRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));
    // Allow to retrieve the layer zip file from S3
    layerUpdaterRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'));
    // Allow to put job success or failure results back to codepipeline
    layerUpdaterRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodePipelineCustomActionAccess'));
    return layerUpdaterRole;
  }

  /**
   * @returns CodeBuild project with a static buildspec provided for simplicity
   */
  private createCodeBuild() {
    return new codebuild.PipelineProject(this, 'LambdaLayerBuilder', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'mkdir -p node_layer/nodejs',
              'cp package.json ./node_layer/nodejs/package.json',
              'cd ./node_layer/nodejs',
              'npm install',
            ]
          },
          build: {
            commands: [
              'rm package-lock.json',
              'cd ..',
              'zip ../layer.zip * -r',
            ]
          }
        },
        artifacts: {
          files: [
            'layer.zip',
          ]
        }
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_5_0
      }
    });
  }
}
