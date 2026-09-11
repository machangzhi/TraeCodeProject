# -*- coding: utf-8 -*-
"""五子棋核心逻辑。

棋盘用二维列表表示：
0 = 空，1 = 黑棋，2 = 白棋。
坐标采用 (row, col)，均从 0 开始。
"""

EMPTY = 0
BLACK = 1
WHITE = 2

PLAYERS = (BLACK, WHITE)
PLAYER_MARKS = {EMPTY: ".", BLACK: "X", WHITE: "O"}

# 四个方向：横、竖、主对角线、副对角线
_DIRECTIONS = ((0, 1), (1, 0), (1, 1), (1, -1))


class GomokuError(Exception):
    """五子棋操作相关的错误。"""


class Board:
    def __init__(self, size=15):
        if size < 5:
            raise ValueError("棋盘边长不能小于 5")
        self.size = size
        self.grid = [[EMPTY] * size for _ in range(size)]

    def in_bounds(self, row, col):
        return 0 <= row < self.size and 0 <= col < self.size

    def is_empty(self, row, col):
        return self.in_bounds(row, col) and self.grid[row][col] == EMPTY

    def place(self, row, col, player):
        """在 (row, col) 落子。成功返回 None，非法操作抛 GomokuError。"""
        if player not in PLAYERS:
            raise GomokuError("无效的玩家：%r" % (player,))
        if not self.in_bounds(row, col):
            raise GomokuError("坐标 (%d, %d) 超出棋盘范围" % (row, col))
        if self.grid[row][col] != EMPTY:
            raise GomokuError("坐标 (%d, %d) 已有棋子" % (row, col))
        self.grid[row][col] = player

    def win_length_at(self, row, col, player, dr, dc):
        """统计以 (row, col) 为中心、沿 (dr, dc) 直线的同色连子数（含自身）。"""
        count = 1
        # 正方向
        r, c = row + dr, col + dc
        while self.in_bounds(r, c) and self.grid[r][c] == player:
            count += 1
            r += dr
            c += dc
        # 反方向
        r, c = row - dr, col - dc
        while self.in_bounds(r, c) and self.grid[r][c] == player:
            count += 1
            r -= dr
            c -= dc
        return count

    def winner_at(self, row, col):
        """判断刚落在 (row, col) 的棋子是否形成五连（含五连以上），返回胜者或 None。"""
        player = self.grid[row][col]
        if player == EMPTY:
            return None
        for dr, dc in _DIRECTIONS:
            if self.win_length_at(row, col, player, dr, dc) >= 5:
                return player
        return None

    def is_full(self):
        return all(self.grid[r][c] != EMPTY
                   for r in range(self.size) for c in range(self.size))

    def render(self):
        """返回带坐标的棋盘文本（列号两位对齐，最多支持 99 路棋盘）。"""
        width = len(str(self.size - 1))
        header = " " * (width + 2) + " ".join(str(c).rjust(width) for c in range(self.size))
        lines = [header]
        for r in range(self.size):
            row_cells = " ".join(
                PLAYER_MARKS[self.grid[r][c]].rjust(width) for c in range(self.size)
            )
            lines.append(str(r).rjust(width) + " | " + row_cells)
        return "\n".join(lines)


class Game:
    """管理轮流落子、胜负与平局的一局五子棋。"""

    def __init__(self, size=15, first_player=BLACK):
        if first_player not in PLAYERS:
            raise ValueError("先手玩家无效")
        self.board = Board(size)
        self.current = first_player
        self.winner = None
        self.finished = False
        self.move_count = 0

    def play(self, row, col):
        """当前玩家落子。落子后切换轮次并判定结束。

        返回值：
            ("win", player)    该局获胜
            ("draw", None)     棋盘下满平局
            ("continue", next) 继续游戏，下一手轮到 next
        """
        if self.finished:
            raise GomokuError("本局已结束，请开新局")
        player = self.current
        self.board.place(row, col, player)
        self.move_count += 1

        winner = self.board.winner_at(row, col)
        if winner is not None:
            self.winner = winner
            self.finished = True
            return "win", winner

        if self.board.is_full():
            self.finished = True
            return "draw", None

        self.current = WHITE if player == BLACK else BLACK
        return "continue", self.current


def _read_int(prompt, size):
    while True:
        text = input(prompt).strip()
        if text.lower() in ("q", "quit", "exit"):
            return None
        try:
            value = int(text)
        except ValueError:
            print("请输入整数坐标（0-%d），或输入 q 退出" % (size - 1))
            continue
        if 0 <= value < size:
            return value
        print("坐标超出范围，请输入 0-%d 之间的整数" % (size - 1))


def main():
    """命令行双人对战入口：python gomoku.py [棋盘边长，默认15]"""
    import sys

    size = int(sys.argv[1]) if len(sys.argv) > 1 else 15
    game = Game(size)
    names = {BLACK: "黑棋 X", WHITE: "白棋 O"}

    print("五子棋双人对战，输入行列坐标落子（0-%d），输入 q 退出。" % (size - 1))
    print(game.board.render())

    while not game.finished:
        print("轮到 %s，已落子 %d 手" % (names[game.current], game.move_count))
        row = _read_int("行 row> ", size)
        if row is None:
            print("已退出。")
            return
        col = _read_int("列 col> ", size)
        if col is None:
            print("已退出。")
            return
        try:
            status, value = game.play(row, col)
        except GomokuError as exc:
            print("非法落子：%s，请重试。" % exc)
            continue

        print(game.board.render())
        if status == "win":
            print("%s 在第 %d 手获胜，恭喜！" % (names[value], game.move_count))
        elif status == "draw":
            print("棋盘下满，平局！")


if __name__ == "__main__":
    main()
