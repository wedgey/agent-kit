# The answer page replaces the canvas and the questions in chat

Each round used to land on a claude.ai Design canvas, and the owner answered through questions asked in chat. The owner looked in one place and answered in another, the canvas could not hold a pick or a note, and a comment on one screen had nowhere to go.

Now each piece of work has one private claude.ai artifact, the answer page. It draws the round from `round.json`, shows every board as a click-through prototype, and takes a pick per screen, a note, and a chat per screen. Answers land in the artifact's database. A hook in the plugin polls that database every 10 seconds for the armed round and submits a prompt when a new owner row arrives, so the session waits without spending tokens. It stops when Claude marks the round handled, or after 6 hours.

Claude redraws on its own when a screen's chat settles a visual change, answers questions in words, and always redraws for the Redraw button. A redraw is a new board, never an edit of one the owner already saw.

Where the page cannot run (no artifact server, or `-p` mode), Claude falls back to board PNGs and a plain-text question. The cost is a template and a hook the plugin now has to keep working with the artifact server's database API.
