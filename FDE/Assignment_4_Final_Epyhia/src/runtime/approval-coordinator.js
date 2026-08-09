export class ApprovalCoordinator {
  constructor({ adminGateClient, webBuilderGateClient, marketerGateClient }) {
    this.adminGateClient = adminGateClient;
    this.webBuilderGateClient = webBuilderGateClient;
    this.marketerGateClient = marketerGateClient;
  }

  async approveAndExecuteDeployment({ actionId, payloadHash, approvedBy, tenantId }) {
    const approval = await this.adminGateClient.approveAction({
      actionId,
      payloadHash,
      approvedBy,
      tenantId,
    });
    const execution = await this.webBuilderGateClient.executeDeploy(actionId);
    return { approval, execution };
  }

  async approveAndExecuteVideo({ actionId, payloadHash, approvedBy, tenantId }) {
    const approval = await this.adminGateClient.approveAction({
      actionId,
      payloadHash,
      approvedBy,
      tenantId,
    });
    const execution = await this.marketerGateClient.executeVideoRender(actionId);
    return { approval, execution };
  }
}
