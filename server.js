const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory room store ───────────────────────────────────────────────────
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

async function wikiPageExists(lang, title) {
  if (!title) return false;

  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&format=json&origin=*`;
  const headers = {
    'User-Agent': 'WikiRaceUltimate/1.0 (local multiplayer game)'
  };

  const { data } = await axios.get(url, { timeout: 7000, headers });
  const pages = data?.query?.pages;
  if (!pages || typeof pages !== 'object') return false;

  return Object.values(pages).some(page => !Object.prototype.hasOwnProperty.call(page, 'missing'));
}

// ─── Wikipedia autocomplete ──────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, lang = 'en' } = req.query;
  if (!q || q.length < 2) return res.json([]);

  const headers = {
    'User-Agent': 'WikiRaceUltimate/1.0 (local multiplayer game)'
  };

  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=8&namespace=0&format=json&origin=*`;
    const { data } = await axios.get(url, { timeout: 5000, headers });
    const suggestions = Array.isArray(data) ? (data[1] || []) : [];
    return res.json(suggestions);
  } catch (openSearchErr) {
    try {
      // Fallback API if OpenSearch is blocked for this runtime/request profile.
      const fallbackUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=prefixsearch&pssearch=${encodeURIComponent(q)}&pslimit=8&format=json&origin=*`;
      const { data } = await axios.get(fallbackUrl, { timeout: 5000, headers });
      const suggestions = data?.query?.prefixsearch?.map(item => item.title).filter(Boolean) || [];
      return res.json(suggestions);
    } catch (fallbackErr) {
      console.warn('[search] autocomplete failed:', {
        q,
        lang,
        openSearchStatus: openSearchErr.response?.status,
        fallbackStatus: fallbackErr.response?.status
      });
      return res.json([]);
    }
  }
});

// ─── Wikipedia proxy ─────────────────────────────────────────────────────────
app.get('/wiki/:lang/:title', async (req, res) => {
  const { lang, title } = req.params;
  try {
    const wikiUrl = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    const { data: html } = await axios.get(wikiUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'WikiRace/1.0' }
    });

    const $ = cheerio.load(html);

    // Remove unwanted elements
    $('script, style, #mw-navigation, #footer, .mw-editsection, #mw-head, #mw-panel, .navbox, .sistersitebox, .vertical-navbox, #toc, .refbegin, .reflist, .references, #catlinks').remove();
    $('link[rel="stylesheet"]').remove();

    // Rewrite internal wiki links
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && href.startsWith('/wiki/') && !href.includes(':')) {
        const pageTitle = href.replace('/wiki/', '');
        $(el).attr('href', `/wiki/${lang}/${pageTitle}`);
        $(el).attr('data-wiki-link', 'true');
      } else {
        $(el).removeAttr('href');
        $(el).addClass('disabled-link');
      }
    });

    // Extract main content
    const content = $('#mw-content-text').html() || $('body').html();
    const pageTitle = $('#firstHeading').text() || title;

    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${pageTitle}</title>
  <link rel="stylesheet" href="https://en.wikipedia.org/w/load.php?modules=site.styles|mediawiki.legacy.commonPrint,shared|mediawiki.skinning.interface&only=styles&skin=vector">
  <style>
    body { font-family: 'Linux Libertine','Georgia',serif; max-width: 960px; margin: 0 auto; padding: 20px; background: #fff; color: #202122; }
    a.disabled-link { color: #54595d; cursor: default; text-decoration: none; pointer-events: none; }
    a[data-wiki-link] { color: #3366cc; }
    a[data-wiki-link]:hover { text-decoration: underline; cursor: pointer; }
    h1 { font-family: 'Linux Libertine','Georgia',serif; font-size: 2em; border-bottom: 1px solid #a2a9b1; margin-bottom: .25em; }
    .mw-parser-output { line-height: 1.6; }
    table { max-width: 100%; overflow-x: auto; display: block; }
    img { max-width: 100%; height: auto; }
    .thumb { float: right; margin: 0 0 1em 1em; }
    #wikirace-hud { display: none; }
  </style>
</head>
<body>
  <h1 id="firstHeading">${pageTitle}</h1>
  <div id="mw-content-text" class="mw-parser-output">
    ${content}
  </div>
  <script>
    // Intercept all link clicks and report to parent
    document.addEventListener('click', function(e) {
      const link = e.target.closest('a[data-wiki-link]');
      if (link) {
        e.preventDefault();
        const href = link.getAttribute('href');
        window.parent.postMessage({ type: 'wikiNav', href: href }, '*');
      }
    }, true);
    // Disable right-click context menu
    document.addEventListener('contextmenu', e => e.preventDefault());
  </script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send(`<h2>Error loading Wikipedia page: ${err.message}</h2>`);
  }
});

// ─── Socket.io game logic ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create room ──
  socket.on('createRoom', ({ playerName }) => {
    const code = generateCode();
    rooms[code] = {
      code,
      leader: socket.id,
      players: {},
      config: { lang: 'en', startPage: '', endPage: '' },
      status: 'lobby', // lobby | playing | finished
      startTime: null,
      winner: null
    };
    rooms[code].players[socket.id] = {
      id: socket.id,
      name: playerName,
      path: [],
      finished: false,
      finishedAt: null
    };
    socket.join(code);
    socket.data.room = code;
    socket.emit('roomCreated', { code, room: sanitizeRoom(rooms[code]) });
    console.log(`Room ${code} created by ${playerName}`);
  });

  // ── Join room ──
  socket.on('joinRoom', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { message: 'Room not found' });
    if (room.status !== 'lobby') return socket.emit('error', { message: 'Game already started' });
    if (Object.keys(room.players).length >= 8) return socket.emit('error', { message: 'Room is full' });

    room.players[socket.id] = {
      id: socket.id,
      name: playerName,
      path: [],
      finished: false,
      finishedAt: null
    };
    socket.join(code);
    socket.data.room = code;
    socket.emit('joinedRoom', { code, room: sanitizeRoom(room) });
    io.to(code).emit('playerJoined', { room: sanitizeRoom(room) });
    console.log(`${playerName} joined room ${code}`);
  });

  // ── Update config (leader only) ──
  socket.on('updateConfig', ({ lang, startPage, endPage }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || room.leader !== socket.id) return;
    room.config = { lang, startPage, endPage };
    io.to(code).emit('configUpdated', { config: room.config });
  });

  // ── Start game (leader only) ──
  socket.on('startGame', async () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || room.leader !== socket.id) return;
    if (!room.config.startPage || !room.config.endPage) {
      return socket.emit('error', { message: 'Configure start and end pages first' });
    }

    try {
      const [startExists, endExists] = await Promise.all([
        wikiPageExists(room.config.lang, room.config.startPage),
        wikiPageExists(room.config.lang, room.config.endPage)
      ]);

      if (!startExists) {
        return socket.emit('error', { message: 'Start page does not exist on Wikipedia' });
      }
      if (!endExists) {
        return socket.emit('error', { message: 'End page does not exist on Wikipedia' });
      }
    } catch {
      return socket.emit('error', { message: 'Could not validate pages on Wikipedia. Try again.' });
    }

    room.status = 'playing';
    room.startTime = Date.now();
    room.winner = null;

    // Reset paths
    Object.values(room.players).forEach(p => {
      p.path = [room.config.startPage];
      p.finished = false;
      p.finishedAt = null;
    });

    io.to(code).emit('gameStarted', {
      config: room.config,
      startTime: room.startTime
    });
    console.log(`Game started in room ${code}: ${room.config.startPage} → ${room.config.endPage}`);
  });

  // ── Return to lobby ──
  socket.on('returnToLobby', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;

    room.status = 'lobby';
    room.startTime = null;
    room.winner = null;

    Object.values(room.players).forEach(p => {
      p.path = [];
      p.finished = false;
      p.finishedAt = null;
    });

    io.to(code).emit('returnedToLobby', { room: sanitizeRoom(room) });
    console.log(`Room ${code} returned to lobby`);
  });

  // ── Player navigated to a page ──
  socket.on('navigate', ({ title }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || room.status !== 'playing') return;
    const player = room.players[socket.id];
    if (!player || player.finished) return;

    player.path.push(title);
    io.to(code).emit('pathUpdate', {
      playerId: socket.id,
      path: player.path
    });

    // Check win condition
    const target = room.config.endPage.replace(/_/g, ' ').toLowerCase();
    const current = title.replace(/_/g, ' ').toLowerCase();

    if (current === target) {
      player.finished = true;
      player.finishedAt = Date.now();
      const elapsed = player.finishedAt - room.startTime;

      if (!room.winner) {
        room.winner = socket.id;
        room.status = 'finished';

        const results = Object.values(room.players).map(p => ({
          id: p.id,
          name: p.name,
          path: p.path,
          finished: p.finished,
          time: p.finishedAt ? p.finishedAt - room.startTime : null
        }));

        io.to(code).emit('gameFinished', {
          winnerId: socket.id,
          winnerName: player.name,
          winnerTime: elapsed,
          results
        });
        console.log(`${player.name} won room ${code} in ${(elapsed/1000).toFixed(1)}s`);
      }
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const playerName = room.players[socket.id]?.name;
    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      delete rooms[code];
      console.log(`Room ${code} deleted (empty)`);
      return;
    }

    // Transfer leadership if leader left
    if (room.leader === socket.id) {
      room.leader = Object.keys(room.players)[0];
      io.to(code).emit('leaderChanged', { newLeaderId: room.leader });
    }

    io.to(code).emit('playerLeft', { playerId: socket.id, playerName, room: sanitizeRoom(room) });
    console.log(`[-] ${playerName} left room ${code}`);
  });
});

function sanitizeRoom(room) {
  return {
    code: room.code,
    leader: room.leader,
    players: Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name,
      path: p.path,
      finished: p.finished
    })),
    config: room.config,
    status: room.status
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🌐 WikiRace server running on http://localhost:${PORT}\n`));
