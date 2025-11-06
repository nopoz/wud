const prometheus = require('./index');

// Mock prom-client
jest.mock('prom-client', () => ({
    collectDefaultMetrics: jest.fn(),
    register: {
        metrics: jest.fn(() => 'mocked_metrics_output'),
    },
}));

// Mock child modules
jest.mock('./container', () => ({
    init: jest.fn(),
}));

jest.mock('./trigger', () => ({
    init: jest.fn(),
}));

jest.mock('./watcher', () => ({
    init: jest.fn(),
}));

jest.mock('./registry', () => ({
    init: jest.fn(),
}));

// Mock log
jest.mock('../log', () => ({
    child: jest.fn(() => ({
        info: jest.fn(),
    })),
}));

describe('Prometheus Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('should initialize all prometheus components', () => {
        const { collectDefaultMetrics } = require('prom-client');
        const container = require('./container');
        const trigger = require('./trigger');
        const watcher = require('./watcher');
        const registry = require('./registry');

        prometheus.init();

        expect(collectDefaultMetrics).toHaveBeenCalled();
        expect(container.init).toHaveBeenCalled();
        expect(registry.init).toHaveBeenCalled();
        expect(trigger.init).toHaveBeenCalled();
        expect(watcher.init).toHaveBeenCalled();
    });

    test('should return metrics output', async () => {
        const { register } = require('prom-client');

        const output = await prometheus.output();

        expect(register.metrics).toHaveBeenCalled();
        expect(output).toBe('mocked_metrics_output');
    });
});
