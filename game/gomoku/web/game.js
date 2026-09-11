/* 五子棋网页版：Canvas 渲染 + 鼠标/触摸点击落子 */
(function () {
  "use strict";

  var SIZE = 15;                 // 15 路棋盘
  var EMPTY = 0, BLACK = 1, WHITE = 2;
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  var canvas = document.getElementById("board");
  var ctx = canvas.getContext("2d");
  var statusText = document.getElementById("statusText");
  var turnIcon = document.getElementById("turnIcon");
  var undoBtn = document.getElementById("undoBtn");
  var restartBtn = document.getElementById("restartBtn");

  var grid, history, current, finished, winLine;
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
    updateStatus();
    undoBtn.disabled = true;
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
    // 木纹底色
    var bg = ctx.createLinearGradient(0, 0, cssSize, cssSize);
    bg.addColorStop(0, "#e8c17a");
    bg.addColorStop(0.5, "#dfae5e");
    bg.addColorStop(1, "#d49c47");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssSize, cssSize);

    // 网格线
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

    // 星位
    var stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
    ctx.fillStyle = "#5d4119";
    stars.forEach(function (s) {
      var pt = intersection(s[0], s[1]);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, Math.max(2.5, cell * 0.09), 0, Math.PI * 2);
      ctx.fill();
    });

    // 棋子
    var radius = cell * 0.44;
    for (var r = 0; r < SIZE; r++) {
      for (var c = 0; c < SIZE; c++) {
        if (grid[r][c] !== EMPTY) drawStone(r, c, grid[r][c], radius);
      }
    }

    // 最后一手标记
    if (history.length > 0 && !winLine) {
      var last = history[history.length - 1];
      var lp = intersection(last.r, last.c);
      ctx.strokeStyle = last.player === BLACK ? "#f5d76e" : "#d9434f";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(lp.x, lp.y, radius * 0.42, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 获胜连线
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

  /* ---------- 交互 ---------- */

  function eventToCell(evt) {
    var rect = canvas.getBoundingClientRect();
    var x = evt.clientX - rect.left;
    var y = evt.clientY - rect.top;
    var c = Math.round((x - padding) / cell);
    var r = Math.round((y - padding) / cell);
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
    // 限制点击容差，点到格子正中央的空地不会误落子
    var pt = intersection(r, c);
    if (Math.hypot(x - pt.x, y - pt.y) > cell * 0.5) return null;
    return { r: r, c: c };
  }

  function handlePlay(evt) {
    if (finished) return;
    var pos = eventToCell(evt);
    if (!pos) return;
    if (grid[pos.r][pos.c] !== EMPTY) return;

    var player = current;
    grid[pos.r][pos.c] = player;
    history.push({ r: pos.r, c: pos.c, player: player });
    undoBtn.disabled = false;

    var line = findWin(pos.r, pos.c, player);
    if (line) {
      finished = true;
      winLine = line;
      statusText.textContent = (player === BLACK ? "黑棋" : "白棋") + "获胜！";
      turnIcon.style.display = "none";
    } else if (history.length === SIZE * SIZE) {
      finished = true;
      statusText.textContent = "棋盘下满，平局！";
      turnIcon.style.display = "none";
    } else {
      current = player === BLACK ? WHITE : BLACK;
      updateStatus();
    }
    draw();
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
      var count = Math.abs(r1 - r2) + Math.abs(c1 - c2) + 1;
      if (count >= 5) {
        return { r1: r1, c1: c1, r2: r2, c2: c2 };
      }
    }
    return null;
  }

  function inBoard(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function undo() {
    if (history.length === 0) return;
    var last = history.pop();
    grid[last.r][last.c] = EMPTY;
    current = last.player;
    finished = false;
    winLine = null;
    undoBtn.disabled = history.length === 0;
    turnIcon.style.display = "inline-block";
    updateStatus();
    draw();
  }

  function restart() {
    initState();
    turnIcon.style.display = "inline-block";
    draw();
  }

  function updateStatus() {
    var isBlack = current === BLACK;
    statusText.textContent = isBlack ? "黑棋回合" : "白棋回合";
    turnIcon.className = "stone-icon " + (isBlack ? "black" : "white");
  }

  canvas.addEventListener("click", handlePlay);
  undoBtn.addEventListener("click", undo);
  restartBtn.addEventListener("click", restart);
  window.addEventListener("resize", resize);

  initState();
  resize();
})();
