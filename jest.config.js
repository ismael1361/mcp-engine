module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    roots: ["<rootDir>/src"],
    setupFilesAfterEnv: ["<rootDir>/src/setupTests.ts"],
    transform: {
        "^.+\\.ts$": "ts-jest",
    },
    moduleNameMapping: {
        "^@/(.*)$": "<rootDir>/src/$1",
    },
    // Configurações adicionais
    testTimeout: 10000,
    clearMocks: true,
    resetMocks: true,
    restoreMocks: true,
    verbose: true,
};
