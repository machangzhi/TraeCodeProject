/**
 * 埋点发送核心（纯逻辑，无 window/document 依赖）
 * Web Worker 与主线程降级共用同一份实现，避免两套行为不一致。
 *
 * 策略严格由 mode 驱动：
 *  - immediate：事件入队后立即发送，绝不启动定时器
 *  - batch：攒满 batchSize 立即发，否则按 flushInterval 定时发；flush() 可随时强制发
 *
 * 发送使用 fetch + keepalive：页面/Worker 被回收后请求仍由浏览器网络栈完成。
 * 发送失败的事件会回到队首，等待下一次触发重试。
 */

var DEFAULTS = {
  reportUrl: "",
  mode: "batch",
  batchSize: 10,
  flushInterval: 2000,
  onResult: null // function({ ok, count, reason })
};

export function createSender(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var queue = [];
  var timer = null;

  function notify(result) {
    if (typeof cfg.onResult === "function") {
      try {
        cfg.onResult(result);
      } catch (e) {
        /* 回调异常不影响发送主流程 */
      }
    }
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function ensureTimer() {
    if (timer !== null) return;
    if (cfg.mode !== "batch" || cfg.flushInterval <= 0) return;
    timer = setTimeout(flush, cfg.flushInterval);
  }

  function send(events) {
    if (!cfg.reportUrl) {
      // 未配置接口：不发请求（事件仍可由调用方在控制台观测）
      notify({ ok: true, count: events.length, reason: "no-report-url" });
      return;
    }

    var body = JSON.stringify({ events: events });
    fetch(cfg.reportUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
      keepalive: true
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        notify({ ok: true, count: events.length });
      })
      .catch(function (err) {
        // 失败回队首，交由下一次定时/入队/手动 flush 重试，不丢数据
        queue = events.concat(queue);
        notify({ ok: false, count: events.length, reason: String(err && err.message || err) });
        ensureTimer();
      });
  }

  function flush() {
    clearTimer();
    if (queue.length === 0) return;
    var events = queue.splice(0, queue.length);
    send(events);
  }

  function push(payload) {
    queue.push(payload);
    if (cfg.mode === "immediate") {
      // 即时模式：立即发送，不启动任何定时器
      flush();
      return;
    }
    // 批量模式：先看条数阈值，否则交给定时器
    if (queue.length >= cfg.batchSize) {
      flush();
    } else {
      ensureTimer();
    }
  }

  function size() {
    return queue.length;
  }

  return { push: push, flush: flush, size: size };
}

export default createSender;
