const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'nexus-dev-secret-change-in-prod';

const allowedOrigins = [
    'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175',
    'https://gen-z-frontend-theta.vercel.app',
    process.env.FRONTEND_URL,
].filter(Boolean);

const app = express();
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'z-talk API v3' }));

// ── AUTH ───────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    try {
        const existing = await db.query('SELECT email FROM users WHERE email=$1', [email.toLowerCase()]);
        if (existing.rows.length) return res.status(409).json({ error: 'This email is already registered.' });
        const hash = await bcrypt.hash(password, 12);
        await db.query('INSERT INTO users (email, password_hash) VALUES ($1,$2)', [email.toLowerCase(), hash]);
        const token = jwt.sign({ email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
        res.status(201).json({ token, email: email.toLowerCase() });
    } catch (err) { console.error('register:', err); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    try {
        const result = await db.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
        if (!result.rows.length) return res.status(401).json({ error: 'Invalid email or password.' });
        const valid = await bcrypt.compare(password, result.rows[0].password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });
        const token = jwt.sign({ email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, email: email.toLowerCase() });
    } catch (err) { console.error('login:', err); res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/verify', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided.' });
    try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        res.json({ email: payload.email });
    } catch { res.status(401).json({ error: 'Token expired or invalid.' }); }
});

// ── Server + Socket.io ─────────────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true },
    maxHttpBufferSize: 10e6,
});

// ── In-memory stores ───────────────────────────────────────────────────────────
const onlineUsers = new Map();   // email → socketId
const lastSeen = new Map();   // email → Date
const userStatus = new Map();   // email → { emoji, text }
// reactions: Map<message_id, Map<emoji, Set<email>>>
const reactions = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────────
const generateId = (email) => `${email}${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;
const makeRoomId = (a, b) => [a, b].sort().join('::');
const emitToUser = (email, event, data) => { const sid = onlineUsers.get(email); if (sid) io.to(sid).emit(event, data); };

const broadcastStatusToRoommates = async (email, isOnline) => {
    try {
        const res = await db.query(
            `SELECT requester_email, recipient_email FROM chat_requests WHERE (requester_email=$1 OR recipient_email=$1) AND status='accepted'`,
            [email]
        );
        const payload = {
            email,
            online: isOnline,
            lastSeen: lastSeen.get(email) || null,
            status: userStatus.get(email) || null,
        };
        res.rows.forEach(row => {
            const peer = row.requester_email === email ? row.recipient_email : row.requester_email;
            emitToUser(peer, 'peer_status_update', payload);
        });
    } catch (err) { console.error('broadcastStatus:', err); }
};

// ── Socket.io ──────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // 1. User online
    socket.on('user_online', async ({ email }) => {
        onlineUsers.set(email, socket.id);
        socket.data.email = email;
        broadcastStatusToRoommates(email, true);
        try {
            const [incoming, accepted, outgoing, groups, latestMsgs] = await Promise.all([
                db.query(`SELECT * FROM chat_requests WHERE recipient_email=$1 AND status='pending' ORDER BY created_at DESC`, [email]),
                db.query(`SELECT * FROM chat_requests WHERE (requester_email=$1 OR recipient_email=$1) AND status='accepted' ORDER BY created_at DESC`, [email]),
                db.query(`SELECT * FROM chat_requests WHERE requester_email=$1 AND status='pending' ORDER BY created_at DESC`, [email]),
                db.query(`SELECT g.* FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_email=$1`, [email]),
                db.query(`
                    SELECT DISTINCT ON (room_id) id, room_id, message_content, created_at, sender_email 
                    FROM messages 
                    WHERE room_id IN (
                        SELECT room_id FROM chat_requests WHERE status='accepted' AND (requester_email=$1 OR recipient_email=$1)
                        UNION
                        SELECT group_id FROM group_members WHERE user_email=$1
                    )
                    ORDER BY room_id, created_at DESC
                `, [email]),
            ]);

            // Auto-join all accepted rooms and groups to receive messages in background
            accepted.rows.forEach(r => socket.join(r.room_id));
            groups.rows.forEach(g => socket.join(g.id));

            // Build online status map for accepted peers
            const onlineMap = {};
            accepted.rows.forEach(row => {
                const peer = row.requester_email === email ? row.recipient_email : row.requester_email;
                onlineMap[peer] = {
                    online: onlineUsers.has(peer),
                    lastSeen: lastSeen.get(peer) || null,
                    status: userStatus.get(peer) || null,
                };
            });
            socket.emit('dashboard_data', {
                incomingRequests: incoming.rows,
                acceptedChats: accepted.rows,
                outgoingRequests: outgoing.rows,
                joinedGroups: groups.rows,
                latestMessages: latestMsgs ? latestMsgs.rows : [],
                onlineMap,
            });
        } catch (err) { console.error('user_online:', err); }
    });

    // 2. Send chat request
    socket.on('send_chat_request', async ({ requester_email, recipient_email }) => {
        if (requester_email === recipient_email)
            return socket.emit('request_error', { message: "You can't send a request to yourself." });
        try {
            const ex = await db.query(
                `SELECT * FROM chat_requests WHERE (requester_email=$1 AND recipient_email=$2) OR (requester_email=$2 AND recipient_email=$1)`,
                [requester_email, recipient_email]
            );
            if (ex.rows.length) {
                const r = ex.rows[0];
                if (r.status === 'accepted') return socket.emit('request_error', { message: 'Already have an active chat with this person.' });
                if (r.status === 'pending') return socket.emit('request_error', { message: 'A request is already pending.' });
                if (r.status === 'rejected') await db.query(`DELETE FROM chat_requests WHERE id=$1`, [r.id]);
            }
            const id = generateId(requester_email);
            const req = { id, requester_email, recipient_email, status: 'pending', created_at: new Date() };
            await db.query(`INSERT INTO chat_requests (id,requester_email,recipient_email,status) VALUES ($1,$2,$3,'pending')`, [id, requester_email, recipient_email]);
            emitToUser(recipient_email, 'incoming_chat_request', req);
            socket.emit('request_sent', req);
        } catch (err) { console.error('send_chat_request:', err); socket.emit('request_error', { message: 'Failed to send request.' }); }
    });

    // 3. Accept request
    socket.on('accept_chat_request', async ({ request_id }) => {
        try {
            const res = await db.query(`SELECT * FROM chat_requests WHERE id=$1`, [request_id]);
            if (!res.rows.length) return;
            const req = res.rows[0];
            const room_id = makeRoomId(req.requester_email, req.recipient_email);
            await db.query(`UPDATE chat_requests SET status='accepted', room_id=$1 WHERE id=$2`, [room_id, request_id]);
            const accepted = { ...req, status: 'accepted', room_id };
            emitToUser(req.requester_email, 'chat_request_accepted', accepted);
            emitToUser(req.recipient_email, 'chat_request_accepted', accepted);
        } catch (err) { console.error('accept:', err); }
    });

    // 4. Reject request
    socket.on('reject_chat_request', async ({ request_id }) => {
        try {
            const res = await db.query(`SELECT * FROM chat_requests WHERE id=$1`, [request_id]);
            if (!res.rows.length) return;
            const req = res.rows[0];
            await db.query(`UPDATE chat_requests SET status='rejected' WHERE id=$1`, [request_id]);
            emitToUser(req.requester_email, 'chat_request_rejected', { request_id });
        } catch (err) { console.error('reject:', err); }
    });

    // 4.5 Groups
    socket.on('create_group', async ({ name, created_by }) => {
        const id = 'group_' + generateId(created_by);
        try {
            await db.query('INSERT INTO groups (id, name, created_by) VALUES ($1, $2, $3)', [id, name, created_by]);
            await db.query('INSERT INTO group_members (group_id, user_email, role) VALUES ($1, $2, $3)', [id, created_by, 'admin']);
            socket.join(id);
            socket.emit('group_created', { id, name, created_by });

            // Refresh dashboard data for groups
            const groups = await db.query(`SELECT g.* FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_email=$1`, [created_by]);
            socket.emit('joined_groups_update', groups.rows);
        } catch (err) { console.error('create_group:', err); }
    });

    socket.on('invite_to_group', async ({ group_id, user_email, inviter_email }) => {
        try {
            await db.query('INSERT INTO group_members (group_id, user_email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [group_id, user_email]);
            const groupRes = await db.query('SELECT * FROM groups WHERE id=$1', [group_id]);
            if (groupRes.rows.length) {
                emitToUser(user_email, 'group_invite', { group: groupRes.rows[0], inviter_email });
                // Send updated groups to the invited user
                const groups = await db.query(`SELECT g.* FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_email=$1`, [user_email]);
                emitToUser(user_email, 'joined_groups_update', groups.rows);
            }
        } catch (err) { console.error('invite_to_group:', err); }
    });


    socket.on('leave_group', async ({ group_id, email }) => {
        try {
            await db.query('DELETE FROM group_members WHERE group_id=$1 AND user_email=$2', [group_id, email]);
            socket.leave(group_id);
            const groups = await db.query(`SELECT g.* FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_email=$1`, [email]);
            socket.emit('joined_groups_update', groups.rows);
            // Optional: Broadcast to group that someone left
        } catch (err) { console.error('leave_group:', err); }
    });

    // 5. Delete conversation
    socket.on('delete_conversation', async ({ request_id, room_id, deleter_email }) => {
        try {
            const res = await db.query(`SELECT * FROM chat_requests WHERE id=$1`, [request_id]);
            if (!res.rows.length) return;
            const req = res.rows[0];
            const peer = req.requester_email === deleter_email ? req.recipient_email : req.requester_email;
            await db.query(`DELETE FROM messages WHERE room_id=$1`, [room_id]);
            await db.query(`DELETE FROM chat_requests WHERE id=$1`, [request_id]);
            reactions.forEach((_, key) => { if (key.includes(room_id)) reactions.delete(key); });
            emitToUser(deleter_email, 'conversation_deleted', { request_id });
            emitToUser(peer, 'conversation_deleted', { request_id });
        } catch (err) { console.error('delete_conversation:', err); }
    });

    // 6. Join room
    socket.on('join_room', async ({ email, room_id }) => {
        socket.join(room_id);
        // Notify others in room so they can show 'Delivered' tick
        socket.to(room_id).emit('peer_joined_room', { email });
        try {
            const res = await db.query(`SELECT * FROM messages WHERE room_id=$1 ORDER BY created_at ASC LIMIT 150`, [room_id]);
            // Attach reactions to each message
            const msgs = res.rows.map(m => ({
                ...m,
                reactions: getReactionSummary(m.id),
            }));
            socket.emit('previous_messages', msgs);
            // Emit peer online status (only for 1v1 chats)
            if (!room_id.startsWith('group_')) {
                const peerRes = await db.query(
                    `SELECT requester_email, recipient_email FROM chat_requests WHERE room_id=$1`, [room_id]
                );
                if (peerRes.rows.length) {
                    const row = peerRes.rows[0];
                    const peer = row.requester_email === email ? row.recipient_email : row.requester_email;
                    socket.emit('peer_status_update', {
                        email: peer,
                        online: onlineUsers.has(peer),
                        lastSeen: lastSeen.get(peer) || null,
                        status: userStatus.get(peer) || null,
                    });
                }
            } else {
                // For groups, optionally fetch group members
                const members = await db.query('SELECT user_email FROM group_members WHERE group_id=$1', [room_id]);
                socket.emit('group_members', { group_id: room_id, members: members.rows });
            }

        } catch (err) { console.error('join_room:', err); }
    });

    // 7. Send message (with optional reply_to)
    socket.on('send_message', async ({ sender_email, message_content, room_id, reply_to }) => {
        const id = generateId(sender_email);
        const msg = { id, sender_email, message_content, room_id, reply_to: reply_to || null, created_at: new Date(), reactions: {} };
        try {
            await db.query(
                `INSERT INTO messages (id,sender_email,message_content,room_id) VALUES ($1,$2,$3,$4)`,
                [id, sender_email, message_content, room_id]
            );
            io.to(room_id).emit('receive_message', msg);
        } catch (err) { console.error('send_message:', err); }
    });

    // 8. Send image (ephemeral)
    socket.on('send_image', ({ sender_email, image_data, room_id }) => {
        const id = generateId(sender_email);
        const msg = { id, sender_email, message_content: `__IMG__${image_data}`, room_id, created_at: new Date(), ephemeral: true, reactions: {} };
        io.to(room_id).emit('receive_message', msg);
    });

    // 9. Delete message
    socket.on('delete_message', async ({ message_id, room_id, sender_email }) => {
        try {
            await db.query(`DELETE FROM messages WHERE id=$1 AND sender_email=$2`, [message_id, sender_email]);
            reactions.delete(message_id);
            io.to(room_id).emit('message_deleted', { message_id });
        } catch (err) { console.error('delete_message:', err); }
    });

    // 10. React to message
    socket.on('react_message', ({ message_id, emoji, email, room_id }) => {
        if (!reactions.has(message_id)) reactions.set(message_id, new Map());
        const msgReactions = reactions.get(message_id);
        if (!msgReactions.has(emoji)) msgReactions.set(emoji, new Set());
        const users = msgReactions.get(emoji);
        if (users.has(email)) {
            users.delete(email);          // toggle off
            if (users.size === 0) msgReactions.delete(emoji);
        } else {
            users.add(email);             // toggle on
        }
        io.to(room_id).emit('reaction_updated', {
            message_id,
            reactions: getReactionSummary(message_id),
        });
    });

    // 11. Mark messages as read
    socket.on('mark_read', ({ room_id, email }) => {
        socket.to(room_id).emit('messages_read', { by: email });
    });

    // 12. Typing indicators
    socket.on('typing_start', ({ room_id, email }) => socket.to(room_id).emit('peer_typing', { email }));
    socket.on('typing_stop', ({ room_id }) => socket.to(room_id).emit('peer_stopped_typing'));

    // 13. Appear Offline / Online (ghost mode — socket stays connected, peer sees you as offline)
    socket.on('appear_offline', ({ email }) => {
        onlineUsers.delete(email);
        lastSeen.set(email, new Date());
        broadcastStatusToRoommates(email, false);
        console.log('[APPEAR OFFLINE]', email);
    });
    socket.on('appear_online', ({ email }) => {
        onlineUsers.set(email, socket.id);
        lastSeen.delete(email);
        broadcastStatusToRoommates(email, true);
        console.log('[APPEAR ONLINE]', email);
    });

    // 14. User status/mood
    socket.on('set_status', ({ email, emoji, text }) => {
        userStatus.set(email, { emoji, text });
        broadcastStatusToRoommates(email, true);
    });

    // 15. Disconnect
    socket.on('disconnect', () => {
        if (socket.data.email) {
            const email = socket.data.email;
            onlineUsers.delete(email);
            lastSeen.set(email, new Date());
            broadcastStatusToRoommates(email, false);
            console.log('[OFFLINE]', email);
        }
    });
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function getReactionSummary(messageId) {
    const msgReactions = reactions.get(messageId);
    if (!msgReactions) return {};
    const summary = {};
    msgReactions.forEach((users, emoji) => { if (users.size > 0) summary[emoji] = users.size; });
    return summary;
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ z-talk Server v3 on port ${PORT}`));
