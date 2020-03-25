# Pulumi EKS with Autoscaling Group using Mixed Instances Policy

## Motivation

Currently, EKS supports managed node groups, but these do not have support for spot instances.
You could use the unmanaged node groups with Pulumi's EKS library, but these currently utilize
a CloudFormation stack for AutoScalingGroup via Launch Configurations instead of Launch Templates,
so it is not possible to get MixedInstancesPolicy to apply herek

This repo provides a minimal example for using Pulumi's AWS library to create an AutoScalingGroup
with the MixedInstancesPolicy and integrating them with EKS.

The steps below are taken from https://github.com/pulumi/kubernetes-guides, but
[index.ts of step 3 (cluster configuration)](./aws/03-cluster-configuration/index.ts)
has been modified to showcase the above example.

| AWS  |
|---|
| [Identity](./aws/01-identity) |
| [Managed Infrastructure](./aws/02-managed-infra) |
| [Cluster Configuration](./aws/03-cluster-configuration) |
