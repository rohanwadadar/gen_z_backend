const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'nexus-dev-secret-change-in-prod';

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    process.env.FRONTEND_URL,
].filter(Boolean);

const app = express();
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));  // Allow larger body for base64 images

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Nexus Chat API v2' }));

// ──────────────────────────────────────────────────────────────────────────────
//  AUTH ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────

// Register
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ error: 'Email and password are required.' });
    if (password.length < 6)
        return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    try {
        const existing = await db.query('SELECT email FROM users WHERE email=$1', [email.toLowerCase()]);
        if (existing.rows.length)
            return res.status(409).json({ error: 'This email is already registered.' });
        const hash = await bcrypt.hash(password, 12);
        await db.query('INSERT INTO users (email, password_hash) VALUES ($1,$2)', [email.toLowerCase(), hash]);
        const token = jwt.sign({ email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
        res.status(201).json({ token, email: email.toLowerCase() });
    } catch (err) {
        console.error('register:', err);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ error: 'Email and password are required.' });
    try {
        const result = await db.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
        if (!result.rows.length)
            return res.status(401).json({ error: 'Invalid email or password.' });
        const valid = await bcrypt.compare(password, result.rows[0].password_hash);
        if (!valid)
            return res.status(401).json({ error: 'Invalid email or password.' });
        const token = jwt.sign({ email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, email: email.toLowerCase() });
    } catch (err) {
        console.error('login:', err);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

// Verify token (used on page refresh to auto-login)
app.get('/api/verify', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer '))
        return res.status(401).json({ error: 'No token provided.' });
    try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        res.json({ email: payload.email });
    } catch {
        res.status(401).json({ error: 'Token expired or invalid.' });
    }
});

// ─── HTTP Server + Socket.io ──────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true },
    maxHttpBufferSize: 10e6,   // 10 MB — needed for image relay
});

// ─── In-memory: email → socketId ──────────────────────────────────────────────
const onlineUsers = new Map();

// ─── Helpers ───────────────────────────────────────────────────────────────────
const generateId = (email) => `${email}${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;
const makeRoomId = (a, b) => [a, b].sort().join('::');
const emitToUser = (email, event, data) => {
    const sid = onlineUsers.get(email);
    if (sid) io.to(sid).emit(event, data);
};

// ─── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // 1. User online
    socket.on('user_online', async ({ email }) => {
        onlineUsers.set(email, socket.id);
        socket.data.email = email;
        try {
            const [incoming, accepted, outgoing] = await Promise.all([
                db.query(`SELECT * FROM chat_requests WHERE recipient_email=$1 AND status='pending' ORDER BY created_at DESC`, [email]),
                db.query(`SELECT * FROM chat_requests WHERE (requester_email=$1 OR recipient_email=$1) AND status='accepted' ORDER BY created_at DESC`, [email]),
                db.query(`SELECT * FROM chat_requests WHERE requester_email=$1 AND status='pending' ORDER BY created_at DESC`, [email]),
            ]);
            socket.emit('dashboard_data', {
                incomingRequests: incoming.rows,
                acceptedChats: accepted.rows,
                outgoingRequests: outgoing.rows,
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
                if (r.status === 'accepted') return socket.emit('request_error', { message: 'You already have an active chat with this person.' });
                if (r.status === 'pending') return socket.emit('request_error', { message: 'A request is already pending.' });
                if (r.status === 'rejected') await db.query(`DELETE FROM chat_requests WHERE id=$1`, [r.id]);
            }
            const id = generateId(requester_email);
            const req = { id, requester_email, recipient_email, status: 'pending', created_at: new Date() };
            await db.query(
                `INSERT INTO chat_requests (id,requester_email,recipient_email,status) VALUES ($1,$2,$3,'pending')`,
                [id, requester_email, recipient_email]
            );
            emitToUser(recipient_email, 'incoming_chat_request', req);
            socket.emit('request_sent', req);
        } catch (err) {
            console.error('send_chat_request:', err);
            socket.emit('request_error', { message: 'Failed to send request.' });
        }
    });

    // 3. Accept request
    socket.on('accept_chat_request', async ({ request_id, acceptor_email }) => {
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
            emitToUser(req.recipient_email, 'request_removed', { request_id });
        } catch (err) { console.error('reject:', err); }
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
            emitToUser(deleter_email, 'conversation_deleted', { request_id });
            emitToUser(peer, 'conversation_deleted', { request_id });
        } catch (err) { console.error('delete_conversation:', err); }
    });

    // 6. Join room
    socket.on('join_room', async ({ email, room_id }) => {
        socket.join(room_id);
        try {
            const res = await db.query(
                `SELECT * FROM messages WHERE room_id=$1 ORDER BY created_at ASC LIMIT 100`,
                [room_id]
            );
            socket.emit('previous_messages', res.rows);
        } catch (err) { console.error('join_room:', err); }
    });

    // 7. Send text message (persisted)
    socket.on('send_message', async ({ sender_email, message_content, room_id }) => {
        const id = generateId(sender_email);
        const msg = { id, sender_email, message_content, room_id, created_at: new Date() };
        try {
            await db.query(
                `INSERT INTO messages (id,sender_email,message_content,room_id) VALUES ($1,$2,$3,$4)`,
                [id, sender_email, message_content, room_id]
            );
            io.to(room_id).emit('receive_message', msg);
        } catch (err) { console.error('send_message:', err); }
    });

    // 8. Send image (NOT persisted — relayed only, ephemeral)
    socket.on('send_image', ({ sender_email, image_data, room_id }) => {
        const id = generateId(sender_email);
        const msg = {
            id,
            sender_email,
            message_content: `__IMG__${image_data}`,  // special prefix for frontend to detect
            room_id,
            created_at: new Date(),
            ephemeral: true,  // not saved to DB
        };
        // Relay to everyone in the room (including sender for confirmation)
        io.to(room_id).emit('receive_message', msg);
    });

    // 9. Delete message (author only)
    socket.on('delete_message', async ({ message_id, room_id, sender_email }) => {
        try {
            await db.query(`DELETE FROM messages WHERE id=$1 AND sender_email=$2`, [message_id, sender_email]);
            io.to(room_id).emit('message_deleted', { message_id });
        } catch (err) { console.error('delete_message:', err); }
    });

    // 10. Typing indicators
    socket.on('typing_start', ({ room_id, email }) => socket.to(room_id).emit('peer_typing', { email }));
    socket.on('typing_stop', ({ room_id }) => socket.to(room_id).emit('peer_stopped_typing'));

    // 11. Disconnect
    socket.on('disconnect', () => {
        if (socket.data.email) {
            onlineUsers.delete(socket.data.email);
            console.log('[OFFLINE]', socket.data.email);
        }
    });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`✅ Nexus Chat Server on port ${PORT}`));
