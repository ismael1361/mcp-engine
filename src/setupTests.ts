// Configurações globais para os testes

// Mock do console para evitar poluição nos logs de teste
const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
};

beforeAll(() => {
    // Opcional: Silenciar console durante os testes
    if (process.env.SILENCE_LOGS === "true") {
        console.log = jest.fn();
        console.error = jest.fn();
        console.warn = jest.fn();
        console.info = jest.fn();
    }
});

afterAll(() => {
    // Restaurar console original
    console.log = originalConsole.log;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.info = originalConsole.info;
});

// Configurações globais de timeout
jest.setTimeout(10000); // 10 segundos

// Mock global para localStorage (se necessário para alguns testes)
const localStorageMock = {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn(),
};

// @ts-ignore
global.localStorage = localStorageMock;

// Mock para Math.random para testes determinísticos
let mockRandomValue = 0.5;
jest.spyOn(Math, "random").mockImplementation(() => mockRandomValue);

export const setMockRandom = (value: number) => {
    mockRandomValue = value;
};

export const resetMockRandom = () => {
    mockRandomValue = 0.5;
};
