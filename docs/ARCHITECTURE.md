# Architecture

How the pieces fit, for anyone changing this who did not write it.

The short version: **the browser does everything that matters.** The server exists to hold one secret
and one folder. If you deleted the server, the game would still play - you would lose the portraits and
the shared leaderboard, and nothing else.
