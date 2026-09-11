/* 五子棋网页版：Canvas 渲染 + 点击落子 + 人机对战 + 落子序号 + 棋谱导入导出 */
(function () {
  "use strict";

  var SIZE = 15;                 // 15 路棋盘
  var EMPTY = 0, BLACK = 1, WHITE = 2;
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  var MODE_PVP = "pvp", MODE_PVE = "pve";
  var HUMAN = BLACK, AI = WHITE; // 人机模式玩家执黑

  var canvas = document.getElementById("board");
  var ctx = canvas.getContext("2d");
  var statusText = document.getElementById("statusText");
  var turnIcon = document.getElementById("turnIcon");
  var undoBtn = document.getElementById("undoBtn");
  var restartBtn = document.getElementById("restartBtn");
  var exportBtn = document.getElementById("exportBtn");
  var importBtn = document.getElementById("importBtn");
  var modePvpBtn = document.getElementById("modePvp");
  var modePveBtn = document.getElementById("modePve");

  var modal = document.getElementById("recordModal");
  var modalTitle = document.getElementById("modalTitle");
  var recordText = document.getElementById("recordText");
  var modalHint = document.getElementById("modalHint");
  var copyBtn = document.getElementById("copyBtn");
  var importApplyBtn = document.getElementById("importApplyBtn");
  var modalCloseBtn = document.getElementById("modalCloseBtn");

  var grid, history, current, finished, winLine, mode, aiTimer, aiToken;
  var cssSize = 0, cell = 0, padding = 0, dpr = 1;

  function initState() {
    grid = [];
    for (var r = 0; r < SIZE; r++) {
      grid.push(new Array(SIZE).fill(EMPTY));
    }
    history = [];
    current = BLACK;
    finished = false;
    winLine = null;
    clearAiTimer();
    undoBtn.disabled = true;
    turnIcon.style.display = "inline-block";
    updateStatus();
  }

  function clearAiTimer() {
    aiToken = (aiToken || 0) + 1;
    if (aiTimer) {
      clearTimeout(aiTimer);
      aiTimer = null;
    }
  }

  /* ---------- 尺寸与绘制 ---------- */

  function resize() {
    var rect = canvas.parentElement.getBoundingClientRect();
    cssSize = Math.max(200, Math.floor(rect.width));
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    canvas.style.width = cssSize + "px";
    canvas.style.height = cssSize + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    padding = cssSize * 0.045;
    cell = (cssSize - padding * 2) / (SIZE - 1);
    draw();
  }

  function intersection(r, c) {
    return { x: padding + c * cell, y: padding + r * cell };
  }

  function draw() {
    var bg = ctx.createLinearGradient(0, 0, cssSize, cssSize);
    bg.addColorStop(0, "#e8c17a");
    bg.addColorStop(0.5, "#dfae5e");
    bg.addColorStop(1, "#d49c47");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssSize, cssSize);

    ctx.strokeStyle = "#5d4119";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var i = 0; i < SIZE; i++) {
      var p = intersection(i, i);
      ctx.moveTo(padding, p.y);
      ctx.lineTo(cssSize - padding, p.y);
      ctx.moveTo(p.x, padding);
      ctx.lineTo(p.x, cssSize - padding);
    }
    ctx.stroke();

    var stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
    ctx.fillStyle = "#5d4119";
    stars.forEach(function (s) {
      var pt = intersection(s[0], s[1]);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, Math.max(2.5, cell * 0.09), 0, Math.PI * 2);
      ctx.fill();
    });

    var radius = cell * 0.44;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (grid[r][c] !== EMPTY) drawStone(r, c, grid[r][c], radius);
      }
    }

    // 落子序号
    var fontSize = Math.max(9, cell * 0.42);
    ctx.font = "600 " + fontSize + "px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    history.forEach(function (m, idx) {
      var pt = intersection(m.r, m.c);
      ctx.fillStyle = m.player === BLACK ? "rgba(255,255,255,0.92)" : "rgba(40,30,10,0.85)";
      ctx.fillText(String(idx + 1), pt.x, pt.y + 0.5);
    });

    if (winLine) {
      var a = intersection(winLine.r1, winLine.c1);
      var b = intersection(winLine.r2, winLine.c2);
      ctx.strokeStyle = "rgba(224, 49, 64, 0.9)";
      ctx.lineWidth = Math.max(4, cell * 0.14);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  function drawStone(r, c, player, radius) {
    var pt = intersection(r, c);
    var grad = ctx.createRadialGradient(
      pt.x - radius * 0.35, pt.y - radius * 0.35, radius * 0.1,
      pt.x, pt.y, radius
    );
    if (player === BLACK) {
      grad.addColorStop(0, "#6f6f6f");
      grad.addColorStop(1, "#080808");
    } else {
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(1, "#c7c7cf");
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /* ---------- 落子与胜负 ---------- */

  function inBoard(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  // 核心落子：不校验轮次合法性以外的输入（调用方保证位置为空），
  // 返回 true 表示游戏结束
  function placeStone(r, c, player) {
    grid[r][c] = player;
    history.push({ r: r, c: c, player: player });
    undoBtn.disabled = false;

    var line = findWin(r, c, player);
    if (line) {
      finished = true;
      winLine = line;
      turnIcon.style.display = "none";
      if (mode === MODE_PVE) {
        statusText.textContent = player === HUMAN ? "你赢了！" : "电脑获胜！";
      } else {
        statusText.textContent = (player === BLACK ? "黑棋" : "白棋") + "获胜！";
      }
      return true;
    }
    if (history.length === SIZE * SIZE) {
      finished = true;
      turnIcon.style.display = "none";
      statusText.textContent = "棋盘下满，平局！";
      return true;
    }

    current = player === BLACK ? WHITE : BLACK;
    updateStatus();
    return false;
  }

  function findWin(r, c, player) {
    for (var i = 0; i < DIRS.length; i++) {
      var dr = DIRS[i][0], dc = DIRS[i][1];
      var r1 = r, c1 = c, r2 = r, c2 = c;
      while (inBoard(r1 + dr, c1 + dc) && grid[r1 + dr][c1 + dc] === player) {
        r1 += dr; c1 += dc;
      }
      while (inBoard(r2 - dr, c2 - dc) && grid[r2 - dr][c2 - dc] === player) {
        r2 -= dr; c2 -= dc;
      }
      // 注意：必须用切比雪夫距离（max），不能用曼哈顿距离，
      // 否则斜向步数会被算成两倍，导致斜向三子误判为五连。
      var count = Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2)) + 1;
      if (count >= 5) {
        return { r1: r1, c1: c1, r2: r2, c2: c2 };
      }
    }
    return null;
  }

  /* ---------- 人机对战 AI（启发式评分） ---------- */

  // 评估在 (r,c) 落 player 子后，单方向的连子价值
  function dirScore(r, c, player, dr, dc) {
    var count = 1, blocks = 0;
    var rr = r + dr, cc = c + dc;
    while (inBoard(rr, cc) && grid[rr][cc] === player) {
      count++; rr += dr; cc += dc;
    }
    if (!inBoard(rr, cc) || grid[rr][cc] !== EMPTY) blocks++;

    rr = r - dr; cc = c - dc;
    while (inBoard(rr, cc) && grid[rr][cc] === player) {
      count++; rr -= dr; cc -= dc;
    }
    if (!inBoard(rr, cc) || grid[rr][cc] !== EMPTY) blocks++;

    var openEnds = 2 - blocks;
    if (count >= 5) return 1000000;
    if (openEnds === 0) return 0;
    if (count === 4) return openEnds === 2 ? 100000 : 10000;
    if (count === 3) return openEnds === 2 ? 5000 : 500;
    if (count === 2) return openEnds === 2 ? 500 : 50;
    return openEnds === 2 ? 10 : 1;
  }

  function pointScore(r, c, player) {
    var total = 0;
    for (var i = 0; i < DIRS.length; i++) {
      total += dirScore(r, c, player, DIRS[i][0], DIRS[i][1]);
    }
    return total;
  }

  function hasNeighbor(r, c, span) {
    for (var dr = -span; dr <= span; dr++) {
      for (var dc = -span; dc <= span; dc++) {
        if (dr === 0 && dc === 0) continue;
        if (inBoard(r + dr, c + dc) && grid[r + dr][c + dc] !== EMPTY) return true;
      }
    }
    return false;
  }

  function aiChooseMove() {
    if (history.length === 0) {
      return { r: Math.floor(SIZE / 2), c: Math.floor(SIZE / 2) };
    }
    var best = null, bestScore = -1;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (grid[r][c] !== EMPTY || !hasNeighbor(r, c, 2)) continue;
        // 进攻分 + 防守分（防守略低于进攻，保证自己有杀招时优先取胜）
        var score = pointScore(r, c, AI) + pointScore(r, c, HUMAN) * 0.9;
        // 轻微的中心偏好，用于同分打破僵局
        var center = (SIZE - 1) / 2;
        score += (SIZE - (Math.abs(r - center) + Math.abs(c - center))) * 0.01;
        if (score > bestScore) {
          bestScore = score;
          best = { r: r, c: c };
        }
      }
    }
    return best || { r: Math.floor(SIZE / 2), c: Math.floor(SIZE / 2) };
  }

  function scheduleAi() {
    var token = aiToken;
    statusText.textContent = "电脑思考中…";
    aiTimer = setTimeout(function () {
      aiTimer = null;
      if (token !== aiToken || finished || current !== AI) return;
      var mv = aiChooseMove();
      placeStone(mv.r, mv.c, AI);
      draw();
    }, 350);
  }

  /* ---------- 交互 ---------- */

  function eventToCell(evt) {
    var rect = canvas.getBoundingClientRect();
    var x = evt.clientX - rect.left;
    var y = evt.clientY - rect.top;
    var c = Math.round((x - padding) / cell);
    var r = Math.round((y - padding) / cell);
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
    var pt = intersection(r, c);
    if (Math.hypot(x - pt.x, y - pt.y) > cell * 0.5) return null;
    return { r: r, c: c };
  }

  function handlePlay(evt) {
    if (finished) return;
    if (mode === MODE_PVE && current === AI) return; // 电脑回合禁止玩家点击
    var pos = eventToCell(evt);
    if (!pos || grid[pos.r][pos.c] !== EMPTY) return;

    var ended = placeStone(pos.r, pos.c, current);
    draw();
    if (!ended && mode === MODE_PVE && current === AI) scheduleAi();
  }

  function undo() {
    if (history.length === 0) return;
    clearAiTimer();

    var last = history.pop();
    grid[last.r][last.c] = EMPTY;
    current = last.player;

    // 人机模式：悔一回合 = 连撤「电脑 + 玩家」两手，回到玩家上一次决策前
    if (mode === MODE_PVE && current === AI && history.length > 0) {
      var prev = history.pop();
      grid[prev.r][prev.c] = EMPTY;
      current = prev.player;
    }

    finished = false;
    winLine = null;
    undoBtn.disabled = history.length === 0;
    turnIcon.style.display = "inline-block";
    updateStatus();
    draw();
  }

  function restart() {
    initState();
    draw();
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    modePvpBtn.classList.toggle("active", mode === MODE_PVP);
    modePveBtn.classList.toggle("active", mode === MODE_PVE);
    restart();
  }

  function updateStatus() {
    var isBlack = current === BLACK;
    if (mode === MODE_PVE) {
      statusText.textContent = current === HUMAN ? "你的回合（黑棋）" : "电脑回合（白棋）";
    } else {
      statusText.textContent = isBlack ? "黑棋回合" : "白棋回合";
    }
    turnIcon.className = "stone-icon " + (isBlack ? "black" : "white");
  }

  /* ---------- 棋谱导入导出 ----------
     格式（纯文本，便于粘贴分享）：
       GOMOKU/1
       size=15
       mode=pve
       moves=r,c;r,c;...
  ------------------------------------ */

  function exportRecord() {
    var moves = history.map(function (m) {
      return m.r + "," + m.c;
    }).join(";");
    return "GOMOKU/1\nsize=" + SIZE + "\nmode=" + mode + "\nmoves=" + moves + "\n";
  }

  function setHint(text, kind) {
    modalHint.textContent = text || "";
    modalHint.className = "modal-hint" + (kind ? " " + kind : "");
  }

  function openExport() {
    modalTitle.textContent = "导出棋谱（共 " + history.length + " 手）";
    recordText.value = exportRecord();
    recordText.readOnly = false; // 允许全选复制
    importApplyBtn.style.display = "none";
    copyBtn.style.display = "";
    setHint(history.length === 0 ? "当前还是空棋盘，导出的是空棋谱。" : "复制后可保存或分享，随时能再导回来续下。");
    modal.hidden = false;
  }

  function openImport() {
    modalTitle.textContent = "导入棋谱";
    recordText.value = "";
    importApplyBtn.style.display = "";
    copyBtn.style.display = "none";
    setHint("");
    modal.hidden = false;
    recordText.focus();
  }

  function parseRecord(text) {
    var lines = text.replace(/\r/g, "").split("\n").map(function (s) {
      return s.trim();
    }).filter(Boolean);
    if (!lines.length || lines[0] !== "GOMOKU/1") {
      throw new Error("缺少 GOMOKU/1 标识，不是本游戏导出的棋谱。");
    }
    var recMode = MODE_PVP, movesStr = "", recSize = SIZE;
    lines.slice(1).forEach(function (line) {
      var kv = line.split("=");
      var key = kv[0], val = kv.slice(1).join("=");
      if (key === "size") recSize = parseInt(val, 10);
      else if (key === "mode") recMode = (val === MODE_PVE) ? MODE_PVE : MODE_PVP;
      else if (key === "moves") movesStr = val;
    });
    if (recSize !== SIZE) throw new Error("棋盘尺寸不匹配（当前仅支持 " + SIZE + " 路）。");

    var moves = [];
    if (movesStr) {
      moves = movesStr.split(";").map(function (pair) {
        var parts = pair.split(",");
        var r = parseInt(parts[0], 10), c = parseInt(parts[1], 10);
        if (!inBoard(r, c)) throw new Error("棋谱含越界坐标：" + pair);
        return { r: r, c: c };
      });
    }
    return { mode: recMode, moves: moves };
  }

  function applyImport() {
    var parsed;
    try {
      parsed = parseRecord(recordText.value);
    } catch (e) {
      setHint(e.message, "error");
      return;
    }

    mode = parsed.mode;
    modePvpBtn.classList.toggle("active", mode === MODE_PVP);
    modePveBtn.classList.toggle("active", mode === MODE_PVE);
    initState();

    var replayPlayer = BLACK;
    for (var i = 0; i < parsed.moves.length; i++) {
      var mv = parsed.moves[i];
      if (grid[mv.r][mv.c] !== EMPTY) {
        setHint("棋谱第 " + (i + 1) + " 手落在已有棋子的位置，导入中止。", "error");
        initState();
        draw();
        return;
      }
      var ended = placeStone(mv.r, mv.c, replayPlayer);
      replayPlayer = replayPlayer === BLACK ? WHITE : BLACK;
      if (ended) break;
    }
    draw();
    modal.hidden = true;
    setHint("");
  }

  function copyRecord() {
    var done = function () { setHint("棋谱已复制到剪贴板。", "success"); };
    var fail = function () {
      recordText.select();
      try {
        document.execCommand("copy");
        done();
      } catch (e) {
        setHint("复制失败，请手动全选（Ctrl+A）复制文本。", "error");
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(recordText.value).then(done, fail);
    } else {
      fail();
    }
  }

  /* ---------- 事件绑定 ---------- */

  canvas.addEventListener("click", handlePlay);
  undoBtn.addEventListener("click", undo);
  restartBtn.addEventListener("click", restart);
  exportBtn.addEventListener("click", openExport);
  importBtn.addEventListener("click", openImport);
  copyBtn.addEventListener("click", copyRecord);
  importApplyBtn.addEventListener("click", applyImport);
  modalCloseBtn.addEventListener("click", function () { modal.hidden = true; });
  modal.addEventListener("click", function (e) {
    if (e.target === modal) modal.hidden = true;
  });
  modePvpBtn.addEventListener("click", function () { setMode(MODE_PVP); });
  modePveBtn.addEventListener("click", function () { setMode(MODE_PVE); });
  window.addEventListener("resize", resize);

  mode = MODE_PVP;
  initState();
  resize();
})();
