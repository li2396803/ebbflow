/* ==========================================================================
   parse-worker：把大 JSON（subs.json ≈ 950KB）的解析放到 Worker
   · 主线程只负责 fetch 文本，JSON.parse 的长任务移出主线程
   · 协议：{ id, text } → { id, ok, data | error }
   ========================================================================== */
self.onmessage = (event) => {
  const msg = event.data || {};
  const { id, text } = msg;
  try {
    const data = JSON.parse(text);
    self.postMessage({ id, ok: true, data });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
};
