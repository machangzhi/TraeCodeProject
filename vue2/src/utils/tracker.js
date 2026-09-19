/**
 * 统一埋点工具（采集在主线程，发送在 Web Worker）
 *
 * 用法（声明式）：在需要埋点的交互元素上加属性即可，无需改动业务逻辑
 *   data-track-name="事件名（必填，使用稳定标识）"
 *   data-track-params='{"module":"counter"}'  （可选，附加业务参数 JSON）
 *
 * 上送通道与策略见 tracker.config.js：
 *   - 默认由 Web Worker 发请求，不阻塞页面；浏览器不支持 Worker 时自动降级主线程
 *   - mode: "immediate" 即时发送 / "batch" 按条数或时间攒批发送
 */

import { createSender } from "./sender-core";
// Worker 工厂：webpack5 用原生语法；老版本 webpack 3/4 改引 "./worker.factory.legacy"
import { createTrackWorker } from "./worker.factory";

var initialized = false;
var worker = null;
var fallbackSender = null; // Worker 不可用时的主线程 sender
var transport = "worker";  // "worker" | "main"

var config = {
  appId: "",
  reportUrl: "",
  enablePV: true,
  debug: true,
  useWorker: true,
  mode: "batch",
  batchSize: 10,
  flushInterval: 2000
};

function senderConfig(extra) {
  return {
    reportUrl: config.reportUrl,
    mode: config.mode,
    batchSize: config.batchSize,
    flushInterval: config.flushInterval,
    onResult: extra && extra.onResult
  };
}

function commonContext() {
  return {
    appId: config.appId,
    page: window.location.pathname + window.location.search,
    pageTitle: document.title,
    referrer: document.referrer || "",
    ua: navigator.userAgent,
    ts: Date.now()
  };
}

function debugLog(payload) {
  if (!config.debug) return;
  // 开发期结构化打印：分组标题即事件名，对象直接挂在分组行上便于核对
  if (window.console && console.groupCollapsed) {
    console.groupCollapsed("[track] " + payload.event + " · " + payload.name, payload);
    console.groupEnd();
  } else {
    console.log("[track]", payload);
  }
}

/* ---------- 传输层初始化 ---------- */

function setupTransport() {
  if (config.useWorker && typeof Worker !== "undefined") {
    try {
      // Worker 构造细节封装在工厂中（原生 / worker-loader 可互换）
      worker = createTrackWorker();
      worker.onmessage = function (e) {
        var msg = e.data || {};
        if (msg.type === "result" && config.debug) {
          var r = msg.result || {};
          if (r.ok && r.reason !== "no-report-url") {
            console.log("[track:worker] 已发送 " + r.count + " 条");
          } else if (!r.ok) {
            console.warn("[track:worker] 发送失败，已入队重试 (" + r.count + " 条)", r.reason);
          }
        }
      };
      worker.onerror = function (err) {
        console.warn("[track] Worker 异常，降级到主线程发送", err.message || err);
        destroyWorker();
        ensureFallback();
      };
      worker.postMessage({ type: "init", config: senderConfig() });
      transport = "worker";
      return;
    } catch (e) {
      console.warn("[track] Worker 创建失败，降级到主线程发送", e);
      worker = null;
    }
  }
  ensureFallback();
}

function ensureFallback() {
  if (fallbackSender) return;
  transport = "main";
  fallbackSender = createSender(
    senderConfig({
      onResult: function (r) {
        if (config.debug && r.ok && r.reason !== "no-report-url") {
          console.log("[track:main] 已发送 " + r.count + " 条");
        }
      }
    })
  );
}

function destroyWorker() {
  if (worker) {
    try {
      worker.terminate();
    } catch (e) {
      /* ignore */
    }
    worker = null;
  }
}

/**
 * 把一条事件交给发送层
 */
function dispatch(payload) {
  if (worker) {
    worker.postMessage({ type: "track", payload: payload });
  } else {
    if (!fallbackSender) ensureFallback();
    fallbackSender.push(payload);
  }
}

function flush() {
  if (worker) {
    worker.postMessage({ type: "flush" });
  } else if (fallbackSender) {
    fallbackSender.flush();
  }
}

/* ---------- 事件委托：从被交互元素向上找最近的埋点节点 ---------- */

function resolveTrackedNode(target) {
  if (!target || typeof target.closest !== "function") return null;
  return target.closest("[data-track-name]");
}

function readParams(node) {
  var raw = node.getAttribute("data-track-params");
  if (!raw) return {};
  try {
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    console.warn("[track] data-track-params 不是合法 JSON，已忽略：", raw);
    return {};
  }
}

function onClick(event) {
  var node = resolveTrackedNode(event.target);
  if (!node) return;
  track(node.getAttribute("data-track-name"), "click", {
    params: readParams(node),
    text: (node.innerText || "").trim().slice(0, 50)
  });
}

function onChange(event) {
  var node = resolveTrackedNode(event.target);
  if (!node) return;
  // 出于隐私考虑默认不采集输入框具体值，只记录元素定位信息
  track(node.getAttribute("data-track-name"), "change", {
    params: readParams(node),
    element: {
      tag: node.tagName.toLowerCase(),
      type: node.type || "",
      id: node.id || "",
      name: node.name || ""
    }
  });
}

/**
 * 记录一条埋点（也可在业务代码中手动调用 tracker.track(...)）
 * @param {string} name 事件名（取自 data-track-name）
 * @param {string} eventType click / change / page_view
 * @param {object} [extra] 附加字段
 */
function track(name, eventType, extra) {
  var payload = Object.assign(commonContext(), {
    event: eventType,
    name: name
  }, extra || {});

  debugLog(payload);
  dispatch(payload);
  return payload;
}

/**
 * 初始化埋点：启动 Worker、绑定全局委托并按需上报 PV。整个应用只应调用一次。
 * @param {object} options 见 tracker.config.js
 */
function initTracker(options) {
  if (initialized) return;
  initialized = true;

  Object.assign(config, options || {});

  setupTransport();

  // 捕获阶段监听，业务里即使 stopPropagation 也能采到
  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);

  // 页面隐藏/关闭前尽量把队列发出去（keepalive 请求在 Worker 终止后仍会完成）
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("beforeunload", flush);
  window.addEventListener("pagehide", flush);

  if (config.enablePV) {
    track("page_view", "page_view");
  }
}

export default {
  init: initTracker,
  track: track,
  flush: flush
};
