const { ValidationError } = require('joi');
const { exec } = require('child_process');
const event = require('../../../event');
const storeContainer = require('../../../store/container'); // Add this mock

jest.mock('child_process');
jest.mock('../../../event');
jest.mock('../../../store/container'); // Add store container mock

const Script = require('./Script');

const script = new Script();

const configurationValid = {
    path: '/path/to/script.sh',
    install: true,
    timeout: 300000
};

beforeEach(() => {
    jest.resetAllMocks();
    // Mock the exec callback
    exec.mockImplementation((command, options, callback) => {
        callback(null, 'success', '');
        return {
            stdout: { on: jest.fn() },
            stderr: { on: jest.fn() },
            on: jest.fn((event, handler) => handler(0))
        };
    });

    // Mock store container methods
    storeContainer.getContainer.mockImplementation((id) => ({
        id,
        name: 'test-container',
        image: { id: 'old-image-id' },
        status: 'running'
    }));
    storeContainer.getContainers.mockImplementation(() => []);
    storeContainer.updateContainer.mockImplementation(container => container);
    storeContainer.deleteContainer.mockImplementation(() => true);
});

describe('Script Trigger Tests', () => {
    // ... existing tests remain the same ...

    test('triggerBatch should reject batch operations', async () => {
        script.configuration = configurationValid;
        const containers = [
            { name: 'container1' },
            { name: 'container2' }
        ];

        await script.triggerBatch(containers);
        
        // Verify warning was logged
        expect(script.log.warn).toHaveBeenCalledWith(
            'Batch operations are not supported by the Script trigger - use individual container triggers instead'
        );
        // Verify script was not executed
        expect(exec).not.toHaveBeenCalled();
    });

    test('cleanupExistingContainers should handle container deletion verification', async () => {
        script.configuration = configurationValid;
        const container = {
            name: 'test-container',
            watcher: 'docker'
        };

        // Mock store to simulate a container that needs cleanup
        storeContainer.getContainers.mockImplementationOnce(() => ([
            { id: 'container1', name: 'test-container', status: 'running' }
        ]));

        await script.cleanupExistingContainers(container);

        expect(storeContainer.deleteContainer).toHaveBeenCalledWith('container1');
        expect(storeContainer.getContainer).toHaveBeenCalledWith('container1');
    });

    test('waitForContainerImageUpdate should detect new container', async () => {
        script.configuration = configurationValid;
        const container = {
            name: 'test-container',
            watcher: 'docker',
            image: { id: 'old-image-id' }
        };

        // Mock store to simulate container update sequence
        storeContainer.getContainers
            .mockImplementationOnce(() => []) // First check - no containers
            .mockImplementationOnce(() => [{ // Second check - new container found
                id: 'new-container',
                name: 'test-container',
                status: 'running',
                image: { id: 'new-image-id' },
                watcher: 'docker'
            }]);

        const result = await script.waitForContainerImageUpdate(container, 'old-image-id');
        
        expect(result).toBeDefined();
        expect(result.image.id).toBe('new-image-id');
    });

    test('executeScript should properly handle and log script output', async () => {
        script.configuration = configurationValid;
        const container = {
            name: 'test-container',
            image: { name: 'test-image' },
            watcher: 'docker',
            updateKind: {
                localValue: '1.0.0',
                remoteValue: '1.0.1'
            }
        };

        // Mock exec with streaming output
        exec.mockImplementation((command, options, callback) => {
            const mockProcess = {
                stdout: { on: jest.fn((event, handler) => {
                    handler('Script is running\n');
                    handler('Progress: 50%\n');
                    handler('Complete\n');
                })},
                stderr: { on: jest.fn() },
                on: jest.fn((event, handler) => handler(0))
            };
            callback(null, 'success', '');
            return mockProcess;
        });

        await script.executeScript(container, 'install');
        
        const execCall = exec.mock.results[0].value;
        expect(execCall.stdout.on).toHaveBeenCalledWith('data', expect.any(Function));
        // Verify log messages were prefixed with container name
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[test-container]'));
    });

    test('setContainerNotification should update container with notification', async () => {
        const container = {
            id: 'test-container',
            name: 'test-container'
        };
        
        script.setContainerNotification(container, 'Test message', 'info');
        
        expect(storeContainer.updateContainer).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'test-container',
                notification: {
                    message: 'Test message',
                    level: 'info'
                }
            })
        );
    });
});