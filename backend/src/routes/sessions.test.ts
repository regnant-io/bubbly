import request from 'supertest';
import express from 'express';
import { sessionsRouter } from './sessions';
import { getDb } from '../db/index';
import { createSession, deleteThread } from '../session/manager';

// Create a test app without starting the server
const testApp = express();
testApp.use(express.json());
testApp.use('/api/sessions', sessionsRouter);

describe('Thread Management API Endpoints', () => {
  let testSessionId: string;
  
  beforeEach(() => {
    // Create a test session
    const session = createSession({
      workspacePath: '/test/workspace',
      provider: 'ollama',
      model: 'test-model',
      threadType: 'vibe_coding',
      threadName: 'Test Thread'
    });
    testSessionId = session.id;
  });
  
  afterEach(() => {
    // Clean up test session
    try {
      deleteThread(testSessionId);
    } catch (err) {
      // Ignore if already deleted
    }
  });
  
  describe('GET /api/sessions/threads', () => {
    it('should list all threads', async () => {
      const response = await request(testApp)
        .get('/api/sessions/threads')
        .expect(200);
      
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      
      const thread = response.body.find((t: { id: string }) => t.id === testSessionId);
      expect(thread).toBeDefined();
      expect(thread.threadType).toBe('vibe_coding');
      expect(thread.threadName).toBe('Test Thread');
    });
    
    it('should filter threads by threadType', async () => {
      const response = await request(testApp)
        .get('/api/sessions/threads?threadType=vibe_coding')
        .expect(200);
      
      expect(Array.isArray(response.body)).toBe(true);
      response.body.forEach((thread: { threadType: string }) => {
        expect(thread.threadType).toBe('vibe_coding');
      });
    });
    
    it('should reject invalid threadType', async () => {
      const response = await request(testApp)
        .get('/api/sessions/threads?threadType=invalid')
        .expect(400);
      
      expect(response.body.error).toContain('Invalid thread type');
    });
    
    it('should filter threads by search query', async () => {
      const response = await request(testApp)
        .get('/api/sessions/threads?search=Test')
        .expect(200);
      
      expect(Array.isArray(response.body)).toBe(true);
      const thread = response.body.find((t: { id: string }) => t.id === testSessionId);
      expect(thread).toBeDefined();
    });
    
    it('should respect limit parameter', async () => {
      const response = await request(testApp)
        .get('/api/sessions/threads?limit=1')
        .expect(200);
      
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeLessThanOrEqual(1);
    });
    
    it('should reject invalid limit', async () => {
      const response = await request(testApp)
        .get('/api/sessions/threads?limit=200')
        .expect(400);
      
      expect(response.body.error).toContain('Invalid limit');
    });
  });
  
  describe('GET /api/sessions/:id', () => {
    it('should get a specific session', async () => {
      const response = await request(testApp)
        .get(`/api/sessions/${testSessionId}`)
        .expect(200);
      
      expect(response.body.id).toBe(testSessionId);
      expect(response.body.threadType).toBe('vibe_coding');
      expect(response.body.threadName).toBe('Test Thread');
    });
    
    it('should return 404 for non-existent session', async () => {
      const response = await request(testApp)
        .get('/api/sessions/non-existent-id')
        .expect(404);
      
      expect(response.body.error).toContain('Session not found');
    });
  });
  
  describe('GET /api/sessions/:id/messages', () => {
    it('should get messages for a session', async () => {
      const response = await request(testApp)
        .get(`/api/sessions/${testSessionId}/messages`)
        .expect(200);
      
      expect(response.body).toHaveProperty('messages');
      expect(response.body).toHaveProperty('approvals');
      expect(Array.isArray(response.body.messages)).toBe(true);
      expect(Array.isArray(response.body.approvals)).toBe(true);
    });
    
    it('should return 404 for non-existent session', async () => {
      const response = await request(testApp)
        .get('/api/sessions/non-existent-id/messages')
        .expect(404);
      
      expect(response.body.error).toContain('Session not found');
    });
  });
  
  describe('POST /api/sessions', () => {
    let createdSessionId: string;
    
    afterEach(() => {
      if (createdSessionId) {
        try {
          deleteThread(createdSessionId);
        } catch (err) {
          // Ignore if already deleted
        }
      }
    });
    
    it('should create a new session', async () => {
      const response = await request(testApp)
        .post('/api/sessions')
        .send({
          workspacePath: '/test/workspace',
          provider: 'claude',
          model: 'claude-3-5-sonnet-20241022',
          threadType: 'spec_session',
          threadName: 'New Spec Thread'
        })
        .expect(201);
      
      createdSessionId = response.body.id;
      
      expect(response.body.id).toBeDefined();
      expect(response.body.threadType).toBe('spec_session');
      expect(response.body.threadName).toBe('New Spec Thread');
      expect(response.body.provider).toBe('claude');
    });
    
    it('should create session with default threadType', async () => {
      const response = await request(testApp)
        .post('/api/sessions')
        .send({
          workspacePath: '/test/workspace',
          provider: 'ollama',
          model: 'test-model'
        })
        .expect(201);
      
      createdSessionId = response.body.id;
      
      expect(response.body.threadType).toBe('vibe_coding');
    });
    
    it('should reject missing workspacePath', async () => {
      const response = await request(testApp)
        .post('/api/sessions')
        .send({
          provider: 'ollama',
          model: 'test-model'
        })
        .expect(400);
      
      expect(response.body.error).toContain('workspacePath is required');
    });
    
    it('should reject invalid provider', async () => {
      const response = await request(testApp)
        .post('/api/sessions')
        .send({
          workspacePath: '/test/workspace',
          provider: 'invalid',
          model: 'test-model'
        })
        .expect(400);
      
      expect(response.body.error).toContain('provider is required');
    });
    
    it('should reject invalid threadType', async () => {
      const response = await request(testApp)
        .post('/api/sessions')
        .send({
          workspacePath: '/test/workspace',
          provider: 'ollama',
          model: 'test-model',
          threadType: 'invalid'
        })
        .expect(400);
      
      expect(response.body.error).toContain('threadType must be');
    });
  });
  
  describe('PATCH /api/sessions/:id', () => {
    it('should update thread name', async () => {
      const response = await request(testApp)
        .patch(`/api/sessions/${testSessionId}`)
        .send({
          threadName: 'Updated Thread Name'
        })
        .expect(200);
      
      expect(response.body.id).toBe(testSessionId);
      expect(response.body.threadName).toBe('Updated Thread Name');
    });
    
    it('should return 404 for non-existent session', async () => {
      const response = await request(testApp)
        .patch('/api/sessions/non-existent-id')
        .send({
          threadName: 'Updated Name'
        })
        .expect(404);
      
      expect(response.body.error).toContain('Session not found');
    });
    
    it('should reject invalid threadName type', async () => {
      const response = await request(testApp)
        .patch(`/api/sessions/${testSessionId}`)
        .send({
          threadName: 123
        })
        .expect(400);
      
      expect(response.body.error).toContain('threadName must be a string');
    });
  });
  
  describe('DELETE /api/sessions/:id', () => {
    it('should delete a thread', async () => {
      const response = await request(testApp)
        .delete(`/api/sessions/${testSessionId}`)
        .expect(200);
      
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('deleted');
      
      // Verify thread is deleted
      const getResponse = await request(testApp)
        .get(`/api/sessions/${testSessionId}`)
        .expect(404);
    });
    
    it('should succeed (idempotently) for a non-existent session', async () => {
      // Deletion is tolerant: improperly-created / already-gone threads must
      // still be removable without erroring, so the UI can always clean up.
      const response = await request(testApp)
        .delete('/api/sessions/non-existent-id')
        .expect(200);
      
      expect(response.body.success).toBe(true);
    });
  });
  
  describe('GET /api/sessions/:id/audit', () => {
    it('should get audit events for a session', async () => {
      const response = await request(testApp)
        .get(`/api/sessions/${testSessionId}/audit`)
        .expect(200);
      
      expect(Array.isArray(response.body)).toBe(true);
    });
  });
});

