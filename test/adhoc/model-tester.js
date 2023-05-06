const {
    Starters: { startWorker },
} = require("@genx/app");

startWorker(
    async (app) => {
        const db = app.db("ffsDemo");
        const Mt4Users = db.model("Mt4Users");

        let users = await Mt4Users.findAll_({
            $limit: 10,
            $orderBy: {
                login: -1,
            },
        });

        console.log(users);

        app.log("info", "Done.");
    },
    {
        workingPath: __dirname,
        modelPath: "src/models",
        configName: "test",
        configPath: "./",
        throwOnError: true,
        logger: {
            level: 'verbose',
        },
    }
);
