const { ValidationError } = require('joi');

const Command = require('./Command');

const command = new Command();

const configurationValid = {
    cmd: 'echo "hello"',
    timeout: 60000,
    shell: '/bin/sh',
    threshold: 'all',
    mode: 'simple',
    once: true,
    auto: true,
    simpletitle: 'New ${kind} found for container ${name}',
    simplebody:
        'Container ${name} running with ${kind} ${local} can be updated to ${kind} ${remote}\n${link}',
    batchtitle: '${count} updates available',
};

beforeEach(() => {
    jest.resetAllMocks();
});

test('validateConfiguration should return validated configuration when valid', () => {
    const validatedConfiguration =
        command.validateConfiguration(configurationValid);
    expect(validatedConfiguration).toStrictEqual(configurationValid);
});

test('validateConfiguration should apply_default_configuration', () => {
    const validatedConfiguration = command.validateConfiguration({
        cmd: configurationValid.cmd,
    });
    expect(validatedConfiguration).toStrictEqual(configurationValid);
});

test('validateConfiguration should throw error when invalid', () => {
    const configuration = {
        command: 123456789,
    };
    expect(() => {
        command.validateConfiguration(configuration);
    }).toThrowError(ValidationError);
});
