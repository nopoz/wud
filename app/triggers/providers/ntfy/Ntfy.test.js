const { ValidationError } = require('joi');

const Ntfy = require('./Ntfy');

const ntfy = new Ntfy();

const configurationValid = {
    url: 'http://xxx.com',
    topic: 'xxx',
    priority: 2,
    mode: 'simple',
    threshold: 'all',
    once: true,
    // eslint-disable-next-line no-template-curly-in-string
    simpletitle: 'New ${kind} found for container ${name}',
    // eslint-disable-next-line no-template-curly-in-string
    simplebody: 'Container ${name} running with ${kind} ${local} can be updated to ${kind} ${remote}\n${link}',
    // eslint-disable-next-line no-template-curly-in-string
    batchtitle: '${count} updates available',
};

test('validateConfiguration should return validated configuration when valid', () => {
    const validatedConfiguration = ntfy.validateConfiguration(configurationValid);
    expect(validatedConfiguration).toStrictEqual(configurationValid);
});

test('validateConfiguration should throw error when invalid', () => {
    const configuration = {
        url: 'git://xxx.com',
    };
    expect(() => {
        ntfy.validateConfiguration(configuration);
    }).toThrowError(ValidationError);
});
