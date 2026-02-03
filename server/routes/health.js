const express = require('express');
const router = express.Router();
const auth = require('../auth');
const { sources, settings, getUserAgent } = require('../db');
const { getDb } = require('../db/sqlite');

const healthCache = new Map();
const CACHE_TTL = 5000; // 5 seconds

function getCache(key) {
    const cached = healthCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > CACHE_TTL) {
        healthCache.delete(key);
        return null;
    }
    return cached.result;
}

function setCache(key, result) {
    healthCache.set(key, { result, timestamp: Date.now() });
}

async function resolveStreamUrl({ sourceType, sourceId, streamId, container }) {
    if (!sourceType || !sourceId || !streamId) return null;

    if (sourceType === 'xtream') {
        const source = await sources.getById(sourceId);
        if (!source || source.type !== 'xtream') return null;
        const baseUrl = source.url.replace(/\/$/, '');
        const ext = container || 'm3u8';
        return `${baseUrl}/live/${source.username}/${source.password}/${streamId}.${ext}`;
    }

    if (sourceType === 'm3u') {
        const db = getDb();
        const row = db.prepare(`
            SELECT stream_url, data
            FROM playlist_items
            WHERE source_id = ? AND item_id = ? AND type = 'live'
            LIMIT 1
        `).get(sourceId, String(streamId));

        if (row?.stream_url) return row.stream_url;
        try {
            const data = row?.data ? JSON.parse(row.data) : null;
            if (data?.stream_url) return data.stream_url;
        } catch (err) {
            // ignore JSON parse errors
        }
        return null;
    }

    return null;
}

async function checkStream(url, userAgent) {
    const headers = {
        'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
        const headRes = await fetch(url, { method: 'HEAD', headers, signal: controller.signal });
        clearTimeout(timeout);
        if (headRes.status > 0) {
            return { ok: headRes.status < 400, status: headRes.status, method: 'HEAD' };
        }
    } catch (err) {
        clearTimeout(timeout);
    }

    const getController = new AbortController();
    const getTimeout = setTimeout(() => getController.abort(), 5000);

    try {
        const getRes = await fetch(url, {
            method: 'GET',
            headers: { ...headers, Range: 'bytes=0-1024' },
            signal: getController.signal
        });
        clearTimeout(getTimeout);
        return { ok: getRes.status < 400, status: getRes.status, method: 'GET' };
    } catch (err) {
        clearTimeout(getTimeout);
        return { ok: false, error: err.message || 'Connection failed' };
    }
}

/**
 * Stream health check
 * POST /api/health/stream
 * Body: { sourceType, sourceId, streamId, container }
 */
router.post('/stream', auth.requireAuth, async (req, res) => {
    try {
        const { sourceType, sourceId, streamId, container } = req.body || {};
        if (!sourceType || !sourceId || !streamId) {
            return res.status(400).json({ error: 'sourceType, sourceId and streamId are required' });
        }

        const url = await resolveStreamUrl({
            sourceType,
            sourceId: parseInt(sourceId),
            streamId,
            container
        });

        if (!url) {
            return res.status(404).json({ ok: false, error: 'Stream URL not found' });
        }

        const cacheKey = `${sourceType}:${sourceId}:${streamId}:${container || ''}`;
        const cached = getCache(cacheKey);
        if (cached) {
            return res.json({ ...cached, cached: true });
        }

        const currentSettings = await settings.get();
        const userAgent = getUserAgent(currentSettings);
        const result = await checkStream(url, userAgent);

        const response = {
            ok: !!result.ok,
            status: result.status || null,
            method: result.method || null,
            checkedAt: Date.now()
        };

        setCache(cacheKey, response);
        res.json(response);
    } catch (err) {
        console.error('Health check failed:', err);
        res.status(500).json({ ok: false, error: 'Health check failed' });
    }
});

module.exports = router;
