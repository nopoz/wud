const { ValidationError } = require('joi');
const rp = require('request-promise-native');

jest.mock('request-promise-native');
const Gotify = require('./Gotify');

const gotify = new Gotify();

const configurationValid = {
    url: 'http://xxx.com',
    token: 'xxx',
    priority: 2,
    mode: 'simple',
    threshold: 'all',
    once: true,
    auto: true,
    simpletitle:
        'New ${container.updateKind.kind} found for container ${container.name}',
    simplebody:
        'Container ${container.name} running with ${container.updateKind.kind} ${container.updateKind.localValue} can be updated to ${container.updateKind.kind} ${container.updateKind.remoteValue}${container.result && container.result.link ? "\\n" + container.result.link : ""}',

    batchtitle: '${containers.length} updates available',
};

beforeEach(() => {
    jest.resetAllMocks();
});

test('validateConfiguration should return validated configuration when valid', () => {
    const validatedConfiguration =
        gotify.validateConfiguration(configurationValid);
    expect(validatedConfiguration).toStrictEqual(configurationValid);
});

test('validateConfiguration should apply default configuration', () => {
    const validatedConfiguration = gotify.validateConfiguration({
        url: configurationValid.url,
        token: configurationValid.token,
    });
    const { priority, ...expectedWithoutPriority } = configurationValid;
    expect(validatedConfiguration).toStrictEqual(expectedWithoutPriority);
});

test('validateConfiguration should throw error when invalid', () => {
    const configuration = {
        url: 'git://xxx.com',
    };
    expect(() => {
        gotify.validateConfiguration(configuration);
    }).toThrowError(ValidationError);
});

test('maskConfiguration should mask sensitive data', () => {
    gotify.configuration = configurationValid;
    expect(gotify.maskConfiguration()).toEqual({
        url: configurationValid.url,
        token: 'x*x',
        priority: 2,
        mode: 'simple',
        threshold: 'all',
        once: true,
        auto: true,
        simpletitle: configurationValid.simpletitle,
        simplebody: configurationValid.simplebody,
        batchtitle: configurationValid.batchtitle,
    });
});

test('trigger should send POST request to Gotify API', async () => {
    gotify.configuration = configurationValid;
    gotify.client = {
        message: {
            createMessage: jest.fn().mockResolvedValue({}),
        },
    };
    const container = {
        name: 'container1',
        updateKind: {
            kind: 'tag',
            localValue: '1.0.0',
            remoteValue: '2.0.0',
        },
    };
    await gotify.trigger(container);
    expect(gotify.client.message.createMessage).toHaveBeenCalledWith({
        title: 'New tag found for container container1',
        message:
            'Container container1 running with tag 1.0.0 can be updated to tag 2.0.0',
        priority: 2,
    });
});

test('should initialize Gotify client on register', async () => {
    const gotifyInstance = new Gotify();
    await gotifyInstance.register('trigger', 'gotify', 'test', {
        url: 'http://gotify.example.com',
        token: 'test-token',
    });

    expect(gotifyInstance.client).toBeDefined();
});

test('triggerBatch should send batch notification', async () => {
    gotify.configuration = configurationValid;
    gotify.client = {
        message: {
            createMessage: jest.fn().mockResolvedValue({}),
        },
    };

    const containers = [
        {
            name: 'test1',
            updateKind: { kind: 'tag', localValue: '1.0', remoteValue: '2.0' },
        },
        {
            name: 'test2',
            updateKind: { kind: 'tag', localValue: '1.1', remoteValue: '2.1' },
        },
    ];

    await gotify.triggerBatch(containers);

    expect(gotify.client.message.createMessage).toHaveBeenCalledWith({
        title: '2 updates available',
        message: expect.any(String),
        priority: 2,
    });
});
