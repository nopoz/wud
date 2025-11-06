// Mock all the router modules
jest.mock('express', () => ({
    Router: jest.fn(() => ({
        use: jest.fn(),
        get: jest.fn(),
    })),
}));

jest.mock('./app', () => ({
    init: jest.fn(() => ({ use: jest.fn(), get: jest.fn() })),
}));
jest.mock('./container', () => ({
    init: jest.fn(() => ({ use: jest.fn(), get: jest.fn() })),
}));
jest.mock('./watcher', () => ({
    init: jest.fn(() => ({ use: jest.fn(), get: jest.fn() })),
}));
jest.mock('./trigger', () => ({
    init: jest.fn(() => ({ use: jest.fn(), get: jest.fn() })),
}));
jest.mock('./registry', () => ({
    init: jest.fn(() => ({ use: jest.fn(), get: jest.fn() })),
}));
jest.mock('./authentication', () => ({
    init: jest.fn(() => ({ use: jest.fn(), get: jest.fn() })),
}));
jest.mock('./log', () => ({
    init: jest.fn(() => ({ use: jest.fn(), get: jest.fn() })),
}));
jest.mock('./store', () => ({
    init: jest.fn(() => ({ use: jest.fn(), get: jest.fn() })),
}));
jest.mock('./server', () => ({
    init: jest.fn(() => ({ use: jest.fn(), get: jest.fn() })),
}));
jest.mock('./auth', () => ({
    getAllIds: jest.fn(() => ['basic', 'anonymous']),
}));

// Mock passport
jest.mock('passport', () => ({
    authenticate: jest.fn(() => (req, res, next) => next()),
}));

const api = require('./api');

describe('API Router', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        router = api.init();
    });

    test('should initialize and return a router', () => {
        expect(router).toBeDefined();
    });

    test('should mount all sub-routers', () => {
        const appRouter = require('./app');
        const containerRouter = require('./container');
        const watcherRouter = require('./watcher');
        const triggerRouter = require('./trigger');
        const registryRouter = require('./registry');
        const authenticationRouter = require('./authentication');
        const logRouter = require('./log');
        const storeRouter = require('./store');
        const serverRouter = require('./server');

        expect(appRouter.init).toHaveBeenCalled();
        expect(containerRouter.init).toHaveBeenCalled();
        expect(watcherRouter.init).toHaveBeenCalled();
        expect(triggerRouter.init).toHaveBeenCalled();
        expect(registryRouter.init).toHaveBeenCalled();
        expect(authenticationRouter.init).toHaveBeenCalled();
        expect(logRouter.init).toHaveBeenCalled();
        expect(storeRouter.init).toHaveBeenCalled();
        expect(serverRouter.init).toHaveBeenCalled();
    });

    test('should use passport authentication middleware', () => {
        const passport = require('passport');
        expect(passport.authenticate).toHaveBeenCalledWith([
            'basic',
            'anonymous',
        ]);
    });
});
