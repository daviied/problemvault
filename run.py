"""Start ProblemVault: python run.py  (same as python -m server.app from this folder)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server.app import main  # noqa: E402

main()
