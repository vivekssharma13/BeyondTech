let scenarios = {};
let articles = [];

async function loadScenarios() {

    const scenarioResponse =
        await fetch("data/scenarios.json");

    const articleResponse =
        await fetch("data/articles.json");

    scenarios = await scenarioResponse.json();
    articles = await articleResponse.json();

    const selector = document.getElementById("scenarioSelect");

    selector.addEventListener("change", () => {

        const selectedScenario = selector.value;
        
        localStorage.setItem(
            "selectedScenario",
            selectedScenario
        );
        
        renderScenario(selectedScenario);
    });

    const savedScenario = localStorage.getItem("selectedScenario") || "normal";
    selector.value = savedScenario;
    renderScenario(savedScenario);
}


function renderScenario(scenarioId) {

    const scenario = scenarios[scenarioId];

    if (!scenario) {
        return;
    }

    renderSnapshot(scenario);
    renderExternalSignals();
    renderGenerationMix(scenario);
    renderSignal(scenario);
}


function renderSnapshot(scenario) {

    const container =
        document.getElementById("marketSnapshot");

    container.innerHTML = `

        <div class="metric-card">

            <div class="metric-label">
                Electricity Price
            </div>

            <div class="metric-value">
                ₹${scenario.market.electricityPrice}/kWh
            </div>

            <div class="metric-change">
                ${scenario.market.priceChange}%
            </div>

        </div>


        <div class="metric-card">

            <div class="metric-label">
                System Demand
            </div>

            <div class="metric-value">
                ${scenario.demand.current} GW
            </div>

            <div class="metric-change">
                ${scenario.demand.changePercent}%
            </div>

        </div>


        <div class="metric-card">

            <div class="metric-label">
                Solar Generation
            </div>

            <div class="metric-value">
                ${scenario.renewableGeneration.solar} GW
            </div>

        </div>


        <div class="metric-card">

            <div class="metric-label">
                Wind Generation
            </div>

            <div class="metric-value">
                ${scenario.renewableGeneration.wind} GW
            </div>

        </div>

    `;
}


function renderExternalSignals() {

    const container =
        document.getElementById("externalSignals");

    container.innerHTML = "";

    articles.slice(0, 4).forEach(article => {

        const card =
            document.createElement("div");

        card.className = "article-card";

        card.innerHTML = `

            <div class="article-category">
                ${article.category}
            </div>

            <h3>
                ${article.title}
            </h3>

            <p>
                ${article.description}
            </p>

            <p>
                Source: ${article.source}
            </p>

        `;

        container.appendChild(card);
    });
}


function renderGenerationMix(scenario) {

    const container =
        document.getElementById("generationMix");

    container.innerHTML = `

        <div class="generation-item">

            <div class="generation-label">
                <span>Solar</span>

                <strong>
                    ${scenario.renewableGeneration.solar} GW
                </strong>
            </div>

            <div class="progress">

                <div
                    class="progress-bar"
                    style="width: ${
                        scenario.renewableGeneration.solar / 120 * 100
                    }%">
                </div>

            </div>

        </div>


        <div class="generation-item">

            <div class="generation-label">
                <span>Wind</span>

                <strong>
                    ${scenario.renewableGeneration.wind} GW
                </strong>
            </div>

            <div class="progress">

                <div
                    class="progress-bar"
                    style="width: ${
                        scenario.renewableGeneration.wind / 60 * 100
                    }%">
                </div>

            </div>

        </div>


        <div class="generation-item">

            <div class="generation-label">
                <span>Battery Reserve</span>

                <strong>
                    ${scenario.battery.stateOfCharge}%
                </strong>
            </div>

            <div class="progress">

                <div
                    class="progress-bar"
                    style="width: ${
                        scenario.battery.stateOfCharge
                    }%">
                </div>

            </div>

        </div>

    `;
}


function renderSignal(scenario) {

    const container =
        document.getElementById("signalStatus");

    container.innerHTML = `

        <div class="article-card">

            <h3>
                ${scenario.name}
            </h3>

            <p>
                ${scenario.description}
            </p>

        </div>

    `;
}


loadScenarios();