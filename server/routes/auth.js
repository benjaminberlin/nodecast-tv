const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');

// Configure Passport strategies
auth.configureLocalStrategy(
    async (username) => await db.users.getByUsername(username),
    async (password, hash) => await auth.verifyPassword(password, hash)
);

auth.configureJwtStrategy(
    async (id) => await db.users.getById(id)
);

// Configure Passport session serialization (required for OIDC)
auth.configureSessionSerialization(
    async (id) => await db.users.getById(id)
);

// Configure OIDC Strategy
auth.configureOidcStrategy(
    async (oidcId) => await db.users.getByOidcId(oidcId),
    async (email) => await db.users.getByEmail(email),
    async (userData) => await db.users.create(userData)
);

/**
 * Start OIDC Login
 * GET /api/auth/oidc/login
 */
router.get('/oidc/login', auth.passport.authenticate('openidconnect'));

/**
 * OIDC Callback
 * GET /api/auth/oidc/callback
 */
router.get('/oidc/callback',
    auth.passport.authenticate('openidconnect', { session: false, failureRedirect: '/login.html?error=SSO+Failed' }),
    async (req, res) => {
        // Successful authentication
        const sessionId = crypto.randomUUID();
        let updatedUser = req.user;
        try {
            updatedUser = await db.users.update(req.user.id, {
                lastOnline: new Date().toISOString(),
                sessionId
            });
        } catch (err) {
            console.warn('Failed to update lastOnline for OIDC user:', err.message);
            return res.redirect('/login.html?error=SSO+Failed');
        }
        const token = auth.generateToken(updatedUser, sessionId);

        // Redirect to hompage with token
        res.redirect(`/?token=${token}`);
    }
);

/**
 * Check if initial setup is required
 * GET /api/auth/setup-required
 */
router.get('/setup-required', async (req, res) => {
    try {
        const userCount = await db.users.count();
        res.json({ setupRequired: userCount === 0 });
    } catch (err) {
        console.error('Error in /setup-required:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Initial setup - Create admin user
 * POST /api/auth/setup
 */
router.post('/setup', async (req, res) => {
    try {
        const userCount = await db.users.count();

        // Check if setup already done
        if (userCount > 0) {
            return res.status(400).json({ error: 'Setup already completed' });
        }

        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Create admin user
        const passwordHash = await auth.hashPassword(password);
        const sessionId = crypto.randomUUID();
        const adminUser = await db.users.create({
            username,
            passwordHash,
            role: 'admin',
            lastOnline: new Date().toISOString(),
            sessionId,
            approved: true
        });

        // Generate token for immediate login
        const token = auth.generateToken(adminUser, sessionId);

        res.status(201).json({
            message: 'Admin user created successfully',
            token,
            user: adminUser
        });
    } catch (err) {
        console.error('Error in /setup:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Login with Passport Local Strategy
 * POST /api/auth/login
 */
router.post('/login', (req, res, next) => {
    auth.passport.authenticate('local', { session: false }, async (err, user, info) => {
        if (err) {
            console.error('Login error:', err);
            return res.status(500).json({ error: 'Server error' });
        }

        if (!user) {
            return res.status(401).json({ error: info?.message || 'Invalid credentials' });
        }

        if (user.approved === false) {
            return res.status(403).json({ error: 'Account wartet auf Freigabe' });
        }

        const forceLogin = !!req.body.forceLogin;
        if (user.sessionId && !forceLogin) {
            return res.status(409).json({
                error: 'Du hast bereits eine aktive Sitzung auf einem anderen Gerät.',
                code: 'ACTIVE_SESSION'
            });
        }

        const sessionId = crypto.randomUUID();
        let updatedUser = user;
        try {
            updatedUser = await db.users.update(user.id, {
                lastOnline: new Date().toISOString(),
                sessionId
            });
        } catch (updateErr) {
            console.warn('Failed to update lastOnline on login:', updateErr.message);
            return res.status(500).json({ error: 'Server error' });
        }

        // Generate JWT token
        const token = auth.generateToken(updatedUser, sessionId);

        res.json({
            token,
            user: {
                id: updatedUser.id || user.id,
                username: updatedUser.username || user.username,
                role: updatedUser.role || user.role
            }
        });
    })(req, res, next);
});

/**
 * Logout (client-side handles token removal)
 * POST /api/auth/logout
 */
router.post('/logout', auth.requireAuth, async (req, res) => {
    try {
        await db.users.update(req.user.id, { sessionId: null });
    } catch (err) {
        console.warn('Failed to clear session on logout:', err.message);
    }
    res.json({ success: true, message: 'Logged out successfully' });
});

/**
 * Get current user
 * GET /api/auth/me
 */
router.get('/me', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        try {
            await db.users.update(req.user.id, { lastOnline: new Date().toISOString() });
        } catch (updateErr) {
            console.warn('Failed to update lastOnline on /me:', updateErr.message);
        }

        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            showMovies: !!user.showMovies,
            showSeries: !!user.showSeries,
            coins: typeof user.coins === 'number' ? user.coins : 0,
            passExpiresAt: user.passExpiresAt || null,
            approved: user.approved !== false,
            invitedByUserId: user.invitedByUserId || null,
            inviteId: user.inviteId || null
        });
    } catch (err) {
        console.error('Error in /me:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Get all users (admin only)
 * GET /api/auth/users
 */
router.get('/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const allUsers = await db.users.getAll();
        const userMap = new Map(allUsers.map(u => [u.id, u]));

        // Remove password hashes
        const users = allUsers.map(u => {
            const { passwordHash, ...userWithoutPassword } = u;
            const inviter = u.invitedByUserId ? userMap.get(u.invitedByUserId) : null;
            return {
                ...userWithoutPassword,
                invitedByUsername: inviter ? inviter.username : null,
                approved: u.approved !== false
            };
        });

        res.json(users);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Create a new user (admin only)
 * POST /api/auth/users
 */
router.post('/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { username, password, role } = req.body;

        if (!username || !password || !role) {
            return res.status(400).json({ error: 'Username, password, and role are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        if (!['admin', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'Role must be either "admin" or "viewer"' });
        }

        const passwordHash = await auth.hashPassword(password);
        const newUser = await db.users.create({
            username,
            passwordHash,
            role,
            approved: true
        });

        res.status(201).json(newUser);
    } catch (err) {
        console.error('Error creating user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Approve user (admin only)
 * POST /api/auth/users/:id/approve
 */
router.post('/users/:id/approve', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const updated = await db.users.update(id, { approved: true });
        res.json(updated);
    } catch (err) {
        console.error('Error approving user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Reject user (admin only)
 * POST /api/auth/users/:id/reject
 */
router.post('/users/:id/reject', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await db.users.delete(id);
        res.json({ success: true });
    } catch (err) {
        console.error('Error rejecting user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Create invite (authenticated)
 * POST /api/auth/invites
 */
router.post('/invites', auth.requireAuth, async (req, res) => {
    try {
        const token = crypto.randomBytes(24).toString('base64url');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

        const invite = await db.invites.create({
            token,
            createdByUserId: req.user.id,
            createdAt: new Date().toISOString(),
            expiresAt
        });

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const link = `${protocol}://${host}/invite.html?token=${token}`;

        res.json({
            token,
            link,
            expiresAt: invite.expiresAt
        });
    } catch (err) {
        console.error('Error creating invite:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Validate invite token
 * GET /api/auth/invites/:token
 */
router.get('/invites/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const invite = await db.invites.getByToken(token);
        if (!invite) {
            return res.status(404).json({ valid: false, error: 'Invite not found' });
        }

        if (invite.usedAt || invite.usedByUserId) {
            return res.status(400).json({ valid: false, error: 'Invite already used' });
        }

        if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
            return res.status(400).json({ valid: false, error: 'Invite expired' });
        }

        res.json({ valid: true, expiresAt: invite.expiresAt });
    } catch (err) {
        console.error('Error validating invite:', err);
        res.status(500).json({ valid: false, error: 'Server error' });
    }
});

/**
 * Register with invite token
 * POST /api/auth/register-invite
 */
router.post('/register-invite', async (req, res) => {
    try {
        const { token, username, password } = req.body;

        if (!token || !username || !password) {
            return res.status(400).json({ error: 'Token, username, and password are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const invite = await db.invites.getByToken(token);
        if (!invite) {
            return res.status(404).json({ error: 'Invite not found' });
        }

        if (invite.usedAt || invite.usedByUserId) {
            return res.status(400).json({ error: 'Invite already used' });
        }

        if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
            return res.status(400).json({ error: 'Invite expired' });
        }

        const existing = await db.users.getByUsername(username);
        if (existing) {
            return res.status(400).json({ error: 'Username already exists' });
        }

        const passwordHash = await auth.hashPassword(password);
        const newUser = await db.users.create({
            username,
            passwordHash,
            role: 'viewer',
            approved: false,
            invitedByUserId: invite.createdByUserId,
            inviteId: invite.id
        });

        await db.invites.markUsed(token, newUser.id);

        res.status(201).json({
            success: true,
            message: 'Account created. Waiting for approval.'
        });
    } catch (err) {
        console.error('Error registering invite:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Update a user (admin only)
 * PUT /api/auth/users/:id
 */
router.put('/users/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { username, password, role, showMovies, showSeries, coins, coinsDelta } = req.body;

        const updates = {};

        if (username) {
            updates.username = username;
        }

        if (password) {
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }
            updates.passwordHash = await auth.hashPassword(password);
        }

        if (role) {
            if (!['admin', 'viewer'].includes(role)) {
                return res.status(400).json({ error: 'Role must be either "admin" or "viewer"' });
            }

            // Prevent removing admin role from the last admin
            const user = await db.users.getById(id);
            if (user && user.role === 'admin' && role !== 'admin') {
                const allUsers = await db.users.getAll();
                const adminCount = allUsers.filter(u => u.role === 'admin').length;
                if (adminCount <= 1) {
                    return res.status(400).json({ error: 'Cannot remove admin role from the last admin user' });
                }
            }

            updates.role = role;
        }

        if (typeof showMovies === 'boolean') {
            updates.showMovies = showMovies;
        }

        if (typeof showSeries === 'boolean') {
            updates.showSeries = showSeries;
        }

        if (typeof coins === 'number' && Number.isFinite(coins)) {
            updates.coins = Math.max(0, Math.floor(coins));
        }

        if (typeof coinsDelta === 'number' && Number.isFinite(coinsDelta)) {
            const user = await db.users.getById(id);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            const currentCoins = typeof user.coins === 'number' ? user.coins : 0;
            updates.coins = Math.max(0, currentCoins + Math.trunc(coinsDelta));
        }

        const updatedUser = await db.users.update(id, updates);
        res.json(updatedUser);
    } catch (err) {
        console.error('Error updating user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Redeem pass (user)
 * POST /api/auth/pass/redeem
 */
router.post('/pass/redeem', auth.requireAuth, async (req, res) => {
    try {
        const { plan } = req.body;

        const plans = {
            '24h': { cost: 1, durationMs: 24 * 60 * 60 * 1000 },
            '7d': { cost: 3, durationMs: 7 * 24 * 60 * 60 * 1000 },
            '30d': { cost: 5, durationMs: 30 * 24 * 60 * 60 * 1000 }
        };

        if (!plans[plan]) {
            return res.status(400).json({ error: 'Invalid plan' });
        }

        const user = await db.users.getById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const currentCoins = typeof user.coins === 'number' ? user.coins : 0;
        const { cost, durationMs } = plans[plan];

        if (currentCoins < cost) {
            return res.status(400).json({ error: 'Not enough coins' });
        }

        const now = Date.now();
        const existingExpiry = user.passExpiresAt ? new Date(user.passExpiresAt).getTime() : 0;
        const base = existingExpiry > now ? existingExpiry : now;
        const newExpiry = new Date(base + durationMs).toISOString();

        const updatedUser = await db.users.update(user.id, {
            coins: currentCoins - cost,
            passExpiresAt: newExpiry
        });

        res.json({
            coins: typeof updatedUser.coins === 'number' ? updatedUser.coins : 0,
            passExpiresAt: updatedUser.passExpiresAt || null
        });
    } catch (err) {
        console.error('Error redeeming pass:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Change password (user)
 * POST /api/auth/change-password
 */
router.post('/change-password', auth.requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const user = await db.users.getById(req.user.id);
        if (!user || !user.passwordHash) {
            return res.status(400).json({ error: 'Password change not available for this account' });
        }

        const isValid = await auth.verifyPassword(currentPassword, user.passwordHash);
        if (!isValid) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const passwordHash = await auth.hashPassword(newPassword);
        await db.users.update(user.id, { passwordHash });

        res.json({ success: true });
    } catch (err) {
        console.error('Error changing password:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Delete a user (admin only)
 * DELETE /api/auth/users/:id
 */
router.delete('/users/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent deleting yourself
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        await db.users.delete(id);
        res.json({ success: true, message: 'User deleted successfully' });
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

module.exports = router;
