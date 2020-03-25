import * as aws from "@pulumi/aws";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { config } from "./config";

const projectName = pulumi.getProject();

export const adminsIamRoleArn = config.adminsIamRoleArn
export const devsIamRoleArn = config.devsIamRoleArn
export const stdNodegroupIamRoleArn = config.stdNodegroupIamRoleArn
export const perfNodegroupIamRoleArn = config.perfNodegroupIamRoleArn
const adminsIamRoleName = adminsIamRoleArn.apply(s => s.split("/")).apply(s => s[1])
const devsIamRoleName = devsIamRoleArn.apply(s => s.split("/")).apply(s => s[1])
const stdNodegroupIamRoleName = stdNodegroupIamRoleArn.apply(s => s.split("/")).apply(s => s[1])
const perfNodegroupIamRoleName = perfNodegroupIamRoleArn.apply(s => s.split("/")).apply(s => s[1])

// Create an EKS cluster.
const cluster = new eks.Cluster(`${projectName}`, {
    instanceRoles: [
        aws.iam.Role.get("adminsIamRole", stdNodegroupIamRoleName),
        aws.iam.Role.get("devsIamRole", perfNodegroupIamRoleName),
    ],
    roleMappings: [
        {
            roleArn: config.adminsIamRoleArn,
            groups: ["system:masters"],
            username: "pulumi:admins",
        },
        {
            roleArn: config.devsIamRoleArn,
            groups: ["pulumi:devs"],
            username: "pulumi:alice",
        },
    ],
    vpcId: config.vpcId,
    publicSubnetIds: config.publicSubnetIds,
    privateSubnetIds: config.privateSubnetIds,
    storageClasses: {
        "gp2-encrypted": { type: "gp2", encrypted: true},
        "sc1": { type: "sc1"}
    },
    nodeAssociatePublicIpAddress: false,
    skipDefaultNodeGroup: true,
    deployDashboard: false,
    version: "1.14",
    tags: {
        "Project": "k8s-aws-cluster",
        "Org": "pulumi",
    },
    clusterSecurityGroupTags: { "ClusterSecurityGroupTag": "true" },
    nodeSecurityGroupTags: { "NodeSecurityGroupTag": "true" },
    enabledClusterLogTypes: ["api", "audit", "authenticator", "controllerManager", "scheduler"],
    // endpointPublicAccess: false,     // Requires bastion to access cluster API endpoint
    // endpointPrivateAccess: true,     // Requires bastion to access cluster API endpoint
});

// Export the cluster details.
export const kubeconfig = cluster.kubeconfig.apply(JSON.stringify);
export const clusterName = cluster.core.cluster.name;
export const region = aws.config.region;
export const securityGroupIds = [cluster.nodeSecurityGroup.id];

// Create an AutoScaling group using mixed instances policy and attach to EKS.
const exampleIamInstanceProfile = new aws.iam.InstanceProfile("example", {role: stdNodegroupIamRoleName});

const customUserData = pulumi.output(""); // adjust as needed
const bootstrapExtraArgs = " --kubelet-extra-args '--node-labels=nodegroup=example --register-with-taints=special=true:NoSchedule'";

const userData = pulumi.all([region, clusterName, cluster.core.cluster.endpoint, cluster.core.cluster.certificateAuthority, customUserData])
    .apply(([region, clusterName, clusterEndpoint, clusterCa, customUserData]) => {
        if (customUserData !== "") {
            customUserData = `cat >/opt/user-data <<EOF
${customUserData}
EOF
chmod +x /opt/user-data
/opt/user-data
`;
        }

        return `#!/bin/bash

/etc/eks/bootstrap.sh --apiserver-endpoint "${clusterEndpoint}" --b64-cluster-ca "${clusterCa.data}" "${clusterName}"${bootstrapExtraArgs}
${customUserData}
`;
    });
const userDataBase64 = userData.apply(userData => Buffer.from(userData).toString("base64"));

const exampleLaunchTemplate = new aws.ec2.LaunchTemplate("example", {
    imageId: "ami-0ca5998dc2c88e64b", // k8s v1.14.7 in us-west-2
    instanceType: "t2.micro",
    namePrefix: "example",
    iamInstanceProfile: {
        name: exampleIamInstanceProfile.name,
    },
    vpcSecurityGroupIds: securityGroupIds,
    userData: userDataBase64,
});

const exampleGroup = new aws.autoscaling.Group("example", {
    vpcZoneIdentifiers: config.privateSubnetIds,
    desiredCapacity: 1,
    minSize: 0,
    maxSize: 2,
    mixedInstancesPolicy: {
        launchTemplate: {
            launchTemplateSpecification: {
                launchTemplateId: exampleLaunchTemplate.id,
                version: "$Latest",
            },
            overrides: [
                {
                     instanceType: "t3.nano",
                     weightedCapacity: "1",
                }
            ],
        },
        instancesDistribution: {
            onDemandAllocationStrategy: "prioritized",
            onDemandBaseCapacity: 0,
            onDemandPercentageAboveBaseCapacity: 0,
            spotAllocationStrategy: "lowest-price",
            spotInstancePools: 2,
            spotMaxPrice: "0.04"
        }
    },
    tags: clusterName.apply(clusterName => ([
        {
            key: "Name",
            propagateAtLaunch: true,
            value: `${clusterName}-worker`,
        },
        {
            key: "k8s.io/cluster-autoscaler/enabled",
            propagateAtLaunch: true,
            value: "true",
        },
        {
            key: `k8s.io/cluster-autoscaler/${clusterName}`,
            propagateAtLaunch: true,
            value: "true",
        },
        {
            key: `kubernetes.io/cluster/${clusterName}`,
            propagateAtLaunch: true,
            value: "owned",
        },
    ])),
});

// Do the same thing node group does
// This apply is necessary in s.t. the launchConfiguration picks up a
// dependency on the eksClusterIngressRule. The nodes may fail to
// connect to the cluster if we attempt to create them before the
// ingress rule is applied.
const nodeSecurityGroupId = pulumi.all([cluster.nodeSecurityGroup.id, cluster.eksClusterIngressRule.id])
    .apply(([id]) => id);
