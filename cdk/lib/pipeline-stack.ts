import { Construct } from 'constructs';
import { Duration, RemovalPolicy, Stack, StackProps, Token } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipelineActions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import path from 'path';

interface LambdaLayerPipelineStackProps extends StackProps {
  regionCodesToDistribute: string[],
  layerPrincipal: string,
  organizationId?: string,
}

export default class LambdaLayerPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: LambdaLayerPipelineStackProps) {
    super(scope, id, props);

    const regions = this.validateRegions(props.regionCodesToDistribute);
    this.validateLayerSharing(props.layerPrincipal, props.organizationId);

    // This repository will be used as the source for the layer content
    const repository = this.createRepository();
    const project = this.createCodeBuild();
    const artifactBucket = new s3.Bucket(this, 'PipelineArtifactBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
    });
    const logGroup = new logs.LogGroup(this, 'LayerDistributorLogGroup', {
      logGroupName: '/aws/lambda/LambdaLayerDistributor',
      removalPolicy: RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.ONE_MONTH,
    });

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
      outputs: [buildOutput],
    });

    const layerUpdaterRole = this.createLambdaRole(artifactBucket, logGroup, regions);
    const distributor = new NodejsFunction(this, 'LayerDistributor', {
      // The Lambda source lives in the sibling `src` package, so anchor the esbuild
      // bundling in that package (its own entry, lock file and esbuild install).
      entry: path.join(__dirname, '..', '..', 'src', 'lambda', 'layer-distributor.ts'),
      projectRoot: path.join(__dirname, '..', '..', 'src'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'src', 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_24_X,
      role: layerUpdaterRole,
      functionName: 'LambdaLayerDistributor',
      description: 'Distributes Lambda layers into multiple regions from a single ZIP archive.',
      timeout: Duration.seconds(15),
      memorySize: 512,
      environment: {
        ALLOWED_REGIONS: regions.join(','),
        LAYER_PRINCIPAL: props.layerPrincipal,
        ...(props.organizationId && { ORGANIZATION_ID: props.organizationId }),
      },
    });

    const parallel = regions.map((region) => new codepipelineActions.LambdaInvokeAction({
      actionName: `distribute-${region}`,
      lambda: distributor,
      inputs: [buildOutput],
      userParameters: { region },
    }));

    new codepipeline.Pipeline(this, 'Pipeline', {
      artifactBucket,
      pipelineName: 'LambdaLayerBuilderPipeline',
      pipelineType: codepipeline.PipelineType.V2,
      crossAccountKeys: false,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'Build',
          actions: [buildAction],
        },
        {
          stageName: 'Distribute',
          actions: parallel,
        },
      ],
    });
  }

  private validateRegions(regions: string[]): string[] {
    const uniqueRegions = [...new Set(regions)];
    if (uniqueRegions.length === 0
      || uniqueRegions.length !== regions.length
      || uniqueRegions.some((region) => !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region))) {
      throw new Error('regionCodesToDistribute must contain unique AWS region names');
    }
    return uniqueRegions;
  }

  private validateLayerSharing(layerPrincipal: string, organizationId?: string): void {
    if (layerPrincipal === '*' && !organizationId) {
      throw new Error('A wildcard layer principal requires organizationId');
    }
    if (organizationId && layerPrincipal !== '*') {
      throw new Error('organizationId requires a wildcard layerPrincipal');
    }
    if (organizationId && !/^o-[a-z0-9]{10,32}$/.test(organizationId)) {
      throw new Error('organizationId must be a valid AWS Organizations ID');
    }
    if (!Token.isUnresolved(layerPrincipal)
      && layerPrincipal !== '*'
      && !/^\d{12}$/.test(layerPrincipal)) {
      throw new Error('layerPrincipal must be an AWS account ID or a wildcard with organizationId');
    }
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
      repositoryDescription: 'Contains the source code for a nodejs v24 Lambda layer.',
      // This initializes the main branch with source code from S3
      code: {
        branchName: 'main',
        s3: {
          bucket: asset.s3BucketName,
          key: asset.s3ObjectKey,
        },
      },
    });

    return codecommit.Repository.fromRepositoryArn(this, 'LambdaLayerSourceRepo', cfnRepository.attrArn);
  }

  /**
   * @returns a Lambda execution role with all necessary permissions
   */
  private createLambdaRole(
    artifactBucket: s3.IBucket,
    logGroup: logs.ILogGroup,
    regions: string[],
  ) {
    const layerUpdaterRole = new iam.Role(this, 'LayerUpdaterRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    artifactBucket.grantRead(layerUpdaterRole);
    logGroup.grantWrite(layerUpdaterRole);
    layerUpdaterRole.addToPolicy(new iam.PolicyStatement({
      actions: ['codepipeline:PutJobFailureResult', 'codepipeline:PutJobSuccessResult'],
      resources: ['*'],
    }));
    layerUpdaterRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:AddLayerVersionPermission', 'lambda:PublishLayerVersion'],
      conditions: {
        StringEquals: {
          'aws:RequestedRegion': regions,
        },
      },
      effect: iam.Effect.ALLOW,
      resources: regions.flatMap((region) => [
        `arn:${this.partition}:lambda:${region}:${this.account}:layer:sample-layer`,
        `arn:${this.partition}:lambda:${region}:${this.account}:layer:sample-layer:*`,
      ]),
    }));
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
              'cp package-lock.json ./node_layer/nodejs/package-lock.json',
              'cd ./node_layer/nodejs',
              'npm ci --ignore-scripts --omit=dev',
            ],
          },
          build: {
            commands: [
              'rm package-lock.json',
              'cd ..',
              'zip ../layer.zip * -r',
            ],
          },
        },
        artifacts: {
          files: [
            'layer.zip',
          ],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
    });
  }
}
