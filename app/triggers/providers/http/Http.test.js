const Http = require('./Http');

// Mock request-promise-native
jest.mock('request-promise-native', () => jest.fn());

describe('HTTP Trigger', () => {
    let http;

    beforeEach(() => {
        http = new Http();
        jest.clearAllMocks();
    });

    test('should create instance', () => {
        expect(http).toBeDefined();
        expect(http).toBeInstanceOf(Http);
    });

    test('should have correct configuration schema', () => {
        const schema = http.getConfigurationSchema();
        expect(schema).toBeDefined();
    });

    test('should validate configuration with URL', () => {
        const config = {
            url: 'https://example.com/webhook',
        };

        expect(() => http.validateConfiguration(config)).not.toThrow();
    });

    test('should throw error when URL is missing', () => {
        const config = {};

        expect(() => http.validateConfiguration(config)).toThrow();
    });

    test('should trigger with container', async () => {
        const rp = require('request-promise-native');
        await http.register('trigger', 'http', 'test', {
            url: 'https://example.com/webhook',
        });
        const container = { name: 'test' };

        await http.trigger(container);
        expect(rp).toHaveBeenCalledWith({
            method: 'POST',
            uri: 'https://example.com/webhook',
            body: container,
            json: true,
        });
    });

    test('should trigger batch with containers', async () => {
        const rp = require('request-promise-native');
        await http.register('trigger', 'http', 'test', {
            url: 'https://example.com/webhook',
        });
        const containers = [{ name: 'test1' }, { name: 'test2' }];

        await http.triggerBatch(containers);
        expect(rp).toHaveBeenCalledWith({
            method: 'POST',
            uri: 'https://example.com/webhook',
            body: containers,
            json: true,
        });
    });

    test('should use GET method with query string', async () => {
        const rp = require('request-promise-native');
        await http.register('trigger', 'http', 'test', {
            url: 'https://example.com/webhook',
            method: 'GET',
        });
        const container = { name: 'test' };

        await http.trigger(container);
        expect(rp).toHaveBeenCalledWith({
            method: 'GET',
            uri: 'https://example.com/webhook',
            qs: container,
        });
    });

    test('should use BASIC auth', async () => {
        const rp = require('request-promise-native');
        await http.register('trigger', 'http', 'test', {
            url: 'https://example.com/webhook',
            auth: { type: 'BASIC', user: 'user', password: 'pass' },
        });
        const container = { name: 'test' };

        await http.trigger(container);
        expect(rp).toHaveBeenCalledWith({
            method: 'POST',
            uri: 'https://example.com/webhook',
            body: container,
            json: true,
            auth: { user: 'user', pass: 'pass' },
        });
    });

    test('should use BEARER auth', async () => {
        const rp = require('request-promise-native');
        await http.register('trigger', 'http', 'test', {
            url: 'https://example.com/webhook',
            auth: { type: 'BEARER', bearer: 'token' },
        });
        const container = { name: 'test' };

        await http.trigger(container);
        expect(rp).toHaveBeenCalledWith({
            method: 'POST',
            uri: 'https://example.com/webhook',
            body: container,
            json: true,
            auth: { bearer: 'token' },
        });
    });

    test('should use proxy', async () => {
        const rp = require('request-promise-native');
        await http.register('trigger', 'http', 'test', {
            url: 'https://example.com/webhook',
            proxy: 'http://proxy:8080',
        });
        const container = { name: 'test' };

        await http.trigger(container);
        expect(rp).toHaveBeenCalledWith({
            method: 'POST',
            uri: 'https://example.com/webhook',
            body: container,
            json: true,
            proxy: 'http://proxy:8080',
        });
    });
});
