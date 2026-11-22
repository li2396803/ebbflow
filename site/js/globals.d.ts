// 浏览器全局扩展（渐进类型检查用）：ECharts 兼容挂载点、调试句柄、SW 注册、Network Information API
export {};

declare global {
  interface Window {
    /** 未构建时通过 <script> 注入的 ECharts 命名空间（兼容路径） */
    echarts?: any;
    /** 调试/自检用的身份指纹（main.js stampIdentity） */
    __ETFFLOW__?: any;
    /** 最近的 Service Worker 注册（便于排查） */
    __ebbflowSW?: ServiceWorkerRegistration;
  }

  interface Navigator {
    connection?: {
      saveData?: boolean;
      effectiveType?: string;
    };
  }
}
