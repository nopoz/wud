// Mock express modules
jest.mock('express', () => ({
    Router: jest.fn(() => ({
        use: jest.fn(),
        get: jest.fn(),
    })),
}));

jest.mock('nocache', () => jest.fn());
jest.mock('express-healthcheck', () => jest.fn(() => 'healthcheck-middleware'));

const healthRouter = require('./health');

describe('Health Router', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should initialize router with nocache and healthcheck', () => {
        const router = healthRouter.init();

        expect(router).toBeDefined();
        expect(router.use).toHaveBeenCalled();
        expect(router.get).toHaveBeenCalledWith('/', 'healthcheck-middleware');
    });

    test('should use express-healthcheck middleware', () => {
        const expressHealthcheck = require('express-healthcheck');
        healthRouter.init();

        expect(expressHealthcheck).toHaveBeenCalled();
    });
});
