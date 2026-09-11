# -*- coding: utf-8 -*-
"""gomoku.py 的单元测试。运行：python -m unittest -v"""

import unittest

from gomoku import (
    BLACK,
    WHITE,
    EMPTY,
    Board,
    Game,
    GomokuError,
)


class BoardTest(unittest.TestCase):
    def setUp(self):
        self.board = Board(size=15)

    def test_new_board_is_empty(self):
        self.assertTrue(all(
            self.board.grid[r][c] == EMPTY
            for r in range(15) for c in range(15)
        ))

    def test_board_too_small_rejected(self):
        with self.assertRaises(ValueError):
            Board(size=4)

    def test_place_and_cell_updated(self):
        self.board.place(3, 4, BLACK)
        self.assertEqual(self.board.grid[3][4], BLACK)
        self.assertFalse(self.board.is_empty(3, 4))

    def test_place_out_of_bounds(self):
        with self.assertRaises(GomokuError):
            self.board.place(15, 0, BLACK)
        with self.assertRaises(GomokuError):
            self.board.place(-1, 0, BLACK)
        with self.assertRaises(GomokuError):
            self.board.place(0, 99, WHITE)

    def test_place_on_occupied_cell(self):
        self.board.place(0, 0, BLACK)
        with self.assertRaises(GomokuError):
            self.board.place(0, 0, WHITE)

    def test_place_invalid_player(self):
        with self.assertRaises(GomokuError):
            self.board.place(0, 0, 9)

    def test_horizontal_win(self):
        for c in range(5):
            self.board.place(7, c, BLACK)
        self.assertEqual(self.board.winner_at(7, 4), BLACK)

    def test_horizontal_win_when_more_than_five(self):
        # 六连同样算赢
        for c in range(6):
            self.board.place(2, c + 1, WHITE)
        self.assertEqual(self.board.winner_at(2, 3), WHITE)

    def test_vertical_win(self):
        for r in range(5):
            self.board.place(r, 10, BLACK)
        self.assertEqual(self.board.winner_at(4, 10), BLACK)

    def test_diagonal_down_right_win(self):
        # 主对角线 (r, r)
        for i in range(5):
            self.board.place(i, i, WHITE)
        self.assertEqual(self.board.winner_at(4, 4), WHITE)

    def test_diagonal_down_left_win(self):
        # 副对角线 (i, 4-i)
        for i in range(5):
            self.board.place(i, 4 - i, BLACK)
        self.assertEqual(self.board.winner_at(4, 0), BLACK)

    def test_win_does_not_count_opponent_stones(self):
        # 黑白交错不构成连五
        for c in range(5):
            self.board.place(0, c, BLACK if c % 2 == 0 else WHITE)
        self.assertIsNone(self.board.winner_at(0, 4))

    def test_four_in_a_row_is_not_win(self):
        for c in range(4):
            self.board.place(5, c, BLACK)
        self.assertIsNone(self.board.winner_at(5, 3))

    def test_winner_at_empty_cell(self):
        self.assertIsNone(self.board.winner_at(0, 0))

    def test_board_full_detection(self):
        small = Board(size=5)
        self.assertFalse(small.is_full())
        for r in range(5):
            for c in range(5):
                small.place(r, c, BLACK)
        self.assertTrue(small.is_full())

    def test_render_contains_coordinates(self):
        text = self.board.render()
        self.assertIn("0", text)
        self.assertIn("14", text)


class GameTest(unittest.TestCase):
    def setUp(self):
        # 用小棋盘加快平局测试
        self.game = Game(size=5)

    def test_players_alternate(self):
        self.assertEqual(self.game.current, BLACK)
        status, nxt = self.game.play(0, 0)
        self.assertEqual(status, "continue")
        self.assertEqual(nxt, WHITE)
        status, nxt = self.game.play(1, 1)
        self.assertEqual(nxt, BLACK)

    def test_full_game_horizontal_win(self):
        # 黑棋走第 0 行 0-4 列，白棋在第 4 行应子干扰
        black_cols = [0, 1, 2, 3, 4]
        white_rows = [0, 1, 2, 3]
        result = None
        for i in range(5):
            result = self.game.play(0, black_cols[i])  # 黑
            if result[0] == "win":
                break
            self.game.play(4, white_rows[i])  # 白
        self.assertEqual(result, ("win", BLACK))
        self.assertTrue(self.game.finished)
        self.assertEqual(self.game.winner, BLACK)

    def test_play_after_finish_raises(self):
        for c in range(4):
            self.game.play(0, c)
            self.game.play(4, c)
        self.game.play(0, 4)  # 黑棋五连，游戏结束
        with self.assertRaises(GomokuError):
            self.game.play(3, 3)

    def test_invalid_move_does_not_switch_turn(self):
        before = self.game.current
        with self.assertRaises(GomokuError):
            self.game.play(99, 99)
        self.assertEqual(self.game.current, before)
        self.assertEqual(self.game.move_count, 0)

    def test_draw_on_full_board_without_five(self):
        # 构造一个填满 5x5 且没有任何五连的局面：
        # 黑棋只在第 0、2、4 行落子（会形成横五连），因此改用
        # 交替图案并验证：5x5 棋盘任意同色 5 连即胜，
        # 所以最小无五连满盘需要手工排布。
        # 排布规则：按行列奇偶放子，保证每行/列最多 3 连，
        # 且两条对角线也不出现 5 连。
        # 棋盘格图案：行、列均交替；中心 (2,2) 翻色，
        # 同时打断两条原本同色的长对角线（翻色后各行/列最多 3 连）。
        layout = [
            [BLACK, WHITE, BLACK, WHITE, BLACK],
            [WHITE, BLACK, WHITE, BLACK, WHITE],
            [BLACK, WHITE, WHITE, WHITE, BLACK],
            [WHITE, BLACK, WHITE, BLACK, WHITE],
            [BLACK, WHITE, BLACK, WHITE, BLACK],
        ]
        # 直接把局面填入棋盘，绕过轮流规则，再用 Board 校验无胜者
        board = Board(size=5)
        for r in range(5):
            for c in range(5):
                board.grid[r][c] = layout[r][c]
        self.assertTrue(board.is_full())
        for r in range(5):
            for c in range(5):
                self.assertIsNone(
                    board.winner_at(r, c),
                    "满盘平局布局在 (%d,%d) 出现五连" % (r, c),
                )

    def test_invalid_first_player(self):
        with self.assertRaises(ValueError):
            Game(first_player=EMPTY)


if __name__ == "__main__":
    unittest.main()
