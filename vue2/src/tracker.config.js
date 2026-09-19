// 埋点配置：不同环境可在此切换；reportUrl 留空时只打印到控制台，不发请求
export const trackerConfig = {
  appId: "vue2-webpack-demo",

  // 上报接口地址，例如 "https://your-server.com/track"
  // 请求由 Web Worker 线程发出（POST JSON: { events: [...] }），不阻塞页面
  reportUrl: "",

  // 是否在页面加载时自动上报一次 page_view
  enablePV: true,

  // 是否在控制台打印埋点事件（调试用，生产可关闭）
  debug: true,

  // 是否使用 Web Worker 发送；浏览器不支持时自动降级到主线程
  useWorker: true,

  /* ---------- 上送策略 ---------- */
  // "immediate"：每条事件立即发送（一事件一请求，实时性高）
  // "batch"：攒批发送，满足以下任一条件即发，明显减少请求数
  mode: "batch",

  // batch 模式：队列攒满该条数立即发送
  batchSize: 10,

  // batch 模式：距上次入队超过该毫秒数也会发送（0 表示不定时，仅靠条数/手动 flush）
  flushInterval: 2000
};
