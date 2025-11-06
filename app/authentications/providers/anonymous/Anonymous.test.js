const Anonymous = require('./Anonymous');

describe('Anonymous Authentication', () => {
    let anonymous;

    beforeEach(() => {
        anonymous = new Anonymous();
    });

    test('should create instance', () => {
        expect(anonymous).toBeDefined();
        expect(anonymous).toBeInstanceOf(Anonymous);
    });

    test('should return anonymous strategy', () => {
        const strategy = anonymous.getStrategy();
        expect(strategy).toBeDefined();
        expect(strategy.name).toBe('anonymous');
    });

    test('should return strategy description', () => {
        const description = anonymous.getStrategyDescription();
        expect(description).toEqual({
            type: 'anonymous',
            name: 'Anonymous',
        });
    });
});
