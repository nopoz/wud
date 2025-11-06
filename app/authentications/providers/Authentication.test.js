const Authentication = require('./Authentication');

describe('Authentication Base Class', () => {
    let authentication;

    beforeEach(async () => {
        authentication = new Authentication();
        await authentication.register('authentication', 'test', 'test-auth', {
            key: 'value',
        });
    });

    test('should create instance with default values', () => {
        expect(authentication).toBeDefined();
        expect(authentication.kind).toBe('authentication');
        expect(authentication.type).toBe('test');
        expect(authentication.name).toBe('test-auth');
        expect(authentication.configuration).toEqual({ key: 'value' });
    });

    test('should get id correctly', () => {
        expect(authentication.getId()).toBe('test.test-auth');
    });

    test('should throw error when getStrategy is called on base class', () => {
        expect(() => authentication.getStrategy()).toThrow(
            'getStrategy must be implemented',
        );
    });

    test('should throw error when getStrategyDescription is called on base class', () => {
        expect(() => authentication.getStrategyDescription()).toThrow(
            'getStrategyDescription must be implemented',
        );
    });
});
