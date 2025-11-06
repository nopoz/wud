const Basic = require('./Basic');

describe('Basic Authentication', () => {
    let basic;

    beforeEach(() => {
        basic = new Basic();
    });

    test('should create instance', () => {
        expect(basic).toBeDefined();
        expect(basic).toBeInstanceOf(Basic);
    });

    test('should return basic strategy', () => {
        // Mock configuration to avoid validation errors
        basic.configuration = {
            user: 'testuser',
            hash: '$2b$10$test.hash.value',
        };

        const strategy = basic.getStrategy();
        expect(strategy).toBeDefined();
        expect(strategy.name).toBe('basic');
    });

    test('should return strategy description', () => {
        const description = basic.getStrategyDescription();
        expect(description).toEqual({
            type: 'basic',
            name: 'Login',
        });
    });

    test('should mask configuration hash', () => {
        basic.configuration = {
            user: 'testuser',
            hash: '$2b$10$test.hash.value',
        };
        const masked = basic.maskConfiguration();
        expect(masked.user).toBe('testuser');
        expect(masked.hash).toBe('$********************e');
    });

    test('should authenticate valid user', (done) => {
        const passJs = require('pass');
        basic.configuration = {
            user: 'testuser',
            hash: '$2b$10$test.hash.value',
        };

        passJs.validate = jest.fn((pass, hash, callback) => {
            callback(null, true);
        });

        basic.authenticate('testuser', 'password', (err, result) => {
            expect(result).toEqual({ username: 'testuser' });
            done();
        });
    });

    test('should reject invalid user', (done) => {
        basic.configuration = {
            user: 'testuser',
            hash: '$2b$10$test.hash.value',
        };

        basic.authenticate('wronguser', 'password', (err, result) => {
            expect(result).toBe(false);
            done();
        });
    });

    test('should reject invalid password', (done) => {
        const passJs = require('pass');
        basic.configuration = {
            user: 'testuser',
            hash: '$2b$10$test.hash.value',
        };

        passJs.validate = jest.fn((pass, hash, callback) => {
            callback(null, false);
        });

        basic.authenticate('testuser', 'wrongpassword', (err, result) => {
            expect(result).toBe(false);
            done();
        });
    });
});
