import type { CapabilityReport, CapabilityId, JevBrowserConfig } from './index.js';

/**
 * 能力探测（DESIGN §11）：依据当前配置推导能力清单。
 * 未知/未实测能力标 'unverified'，绝不冒充 supported；
 * attach 相关的浏览器级行为以 P0 实测为准。
 */
export function describeCapabilities(cfg: JevBrowserConfig): CapabilityReport[] {
  const b = cfg.browser;
  const attach = b.mode === 'attach';
  const report: Array<{ id: CapabilityId; state: CapabilityReport['state']; detail?: string }> = [
    {
      id: 'attach',
      state: attach ? 'supported' : 'unsupported',
      detail: attach ? '默认路径；原生授权流待 P0 实测确认' : '当前 mode=launch',
    },
    { id: 'launch', state: attach ? 'unsupported' : 'supported' },
    { id: 'page-observation', state: 'supported' },
    { id: 'frame-access', state: 'unverified', detail: 'iframe 受限支持；同源策略检查待 P0/P3 实测' },
    {
      id: 'upload',
      state: cfg.safety.allowedUploadDirs.length > 0 ? 'supported' : 'unsupported',
      detail: cfg.safety.allowedUploadDirs.length > 0 ? `${cfg.safety.allowedUploadDirs.length} 个授权目录` : '未配置 safety.allowedUploadDirs（默认拒绝一切上传）',
    },
    {
      id: 'download',
      state: 'supported',
      detail: attach ? '依赖浏览器下载事件与 saveAs；attach 保真度待 P0' : undefined,
    },
    {
      id: 'dialog',
      state: 'unverified',
      detail: '已接管页由 DialogManager 保守处理；未选中页行为待 P0 实测（DESIGN §4.4）',
    },
    { id: 'screenshot', state: 'supported' },
    {
      id: 'detach-preserves-browser',
      state: attach ? 'unverified' : 'supported',
      detail: attach ? 'attach 断开仅清理本连接（P0 端到端复核项，DESIGN §4.3 [S5]）' : '工具拥有的实例可直接关闭',
    },
    { id: 'artifact-save-after-disconnect', state: 'supported', detail: '下载已 saveAs 到受管 artifact 区' },
    { id: 'profile-lock', state: 'supported', detail: '平台用户级锁（尽力而为，不锁人工/其他软件）' },
    {
      id: 'sandbox',
      state: !attach && b.launch.chromiumSandbox ? 'supported' : 'unsupported',
      detail: attach ? 'attach 不控制浏览器进程沙箱' : b.launch.chromiumSandbox ? undefined : 'chromiumSandbox=false（不建议）',
    },
  ];
  return report;
}
