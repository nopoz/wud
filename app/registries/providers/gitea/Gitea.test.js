const Gitea = require('./Gitea');

const gitea = new Gitea();
gitea.configuration = {
    login: 'login',
    password: 'password',
    url: 'https://gitea.acme.com',
};

test('validatedConfiguration should initialize when configuration is valid', () => {
    expect(
        gitea.validateConfiguration({
            url: 'https://gitea.acme.com',
            login: 'login',
            password: 'password',
        }),
    ).toStrictEqual({
        url: 'https://gitea.acme.com',
        login: 'login',
        password: 'password',
    });
});

test('validatedConfiguration should throw error when auth is not base64', () => {
    expect(() => {
        gitea.validateConfiguration({
            url: 'https://gitea.acme.com',
            auth: '°°°',
        });
    }).toThrow('"auth" must be a valid base64 string');
});

test('match should return true when registry url is from gitea', () => {
    expect(
        gitea.match({
            registry: {
                url: 'gitea.acme.com',
            },
        }),
    ).toBeTruthy();
});

test('match should return false when registry url is not from custom', () => {
    expect(
        gitea.match({
            registry: {
                url: 'gitea.notme.io',
            },
        }),
    ).toBeFalsy();
});

test('normalizeImage should return the proper registry v2 endpoint', () => {
    expect(
        gitea.normalizeImage({
            name: 'test/image',
            registry: {
                url: 'gitea.acme.com/test/image',
            },
        }),
    ).toStrictEqual({
        name: 'test/image',
        registry: {
            url: 'https://gitea.acme.com/v2',
        },
    });
});

test('should initialize and prepend https to URL without protocol', () => {
    const giteaInstance = new Gitea();
    giteaInstance.configuration = {
        url: 'gitea.example.com',
        login: 'user',
        password: 'pass',
    };

    giteaInstance.init();
    expect(giteaInstance.configuration.url).toBe('https://gitea.example.com');
});

test('should not modify URL that already has protocol', () => {
    const giteaInstance = new Gitea();
    giteaInstance.configuration = {
        url: 'http://gitea.example.com',
        login: 'user',
        password: 'pass',
    };

    giteaInstance.init();
    expect(giteaInstance.configuration.url).toBe('http://gitea.example.com');
});

test('should validate configuration with auth instead of login/password', () => {
    const config = {
        url: 'https://gitea.example.com',
        auth: Buffer.from('user:pass').toString('base64'),
    };

    expect(() => gitea.validateConfiguration(config)).not.toThrow();
});

test('should validate configuration with empty auth', () => {
    const config = {
        url: 'https://gitea.example.com',
        auth: '',
    };

    expect(() => gitea.validateConfiguration(config)).not.toThrow();
});

test('match should handle URLs with different protocols', () => {
    const giteaWithHttp = new Gitea();
    giteaWithHttp.configuration = { url: 'http://gitea.acme.com' };

    expect(
        giteaWithHttp.match({
            registry: { url: 'https://gitea.acme.com' },
        }),
    ).toBeTruthy();
});

test('match should be case insensitive', () => {
    const giteaUpper = new Gitea();
    giteaUpper.configuration = { url: 'https://GITEA.ACME.COM' };

    expect(
        giteaUpper.match({
            registry: { url: 'gitea.acme.com' },
        }),
    ).toBeTruthy();
});
