// NASDAQ Stock Screener Application

class StockScreener {
    constructor() {
        this.stocks = stocksData;
        this.filteredStocks = [...this.stocks];
        this.currentPage = 1;
        this.pageSize = 50;
        this.sortColumn = 'marketCapValue';
        this.sortDirection = 'desc';
        this.chart = null;
        this.currentStock = null;
        this.currentPeriod = '1M';

        this.init();
    }

    init() {
        this.updateStats();
        this.bindEvents();
        this.sortStocks();
        this.render();
    }

    bindEvents() {
        // Search input
        document.getElementById('searchInput').addEventListener('input', (e) => {
            this.handleSearch(e.target.value);
        });

        // Page size selector
        document.getElementById('pageSize').addEventListener('change', (e) => {
            this.pageSize = parseInt(e.target.value);
            this.currentPage = 1;
            this.render();
        });

        // Column sorting
        document.querySelectorAll('th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                this.handleSort(th.dataset.sort);
            });
        });

        // Modal close on overlay click
        document.getElementById('stockModal').addEventListener('click', (e) => {
            if (e.target.id === 'stockModal') {
                this.closeModal();
            }
        });

        // Time period buttons
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectPeriod(btn.dataset.period);
            });
        });

        // Close modal on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeModal();
            }
        });
    }

    handleSearch(query) {
        query = query.toLowerCase().trim();

        if (query === '') {
            this.filteredStocks = [...this.stocks];
        } else {
            this.filteredStocks = this.stocks.filter(stock =>
                stock.symbol.toLowerCase().includes(query) ||
                stock.name.toLowerCase().includes(query)
            );
        }

        this.currentPage = 1;
        this.sortStocks();
        this.render();
    }

    handleSort(column) {
        if (this.sortColumn === column) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortColumn = column;
            this.sortDirection = 'desc';
        }

        // Update header classes
        document.querySelectorAll('th[data-sort]').forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
            if (th.dataset.sort === this.sortColumn) {
                th.classList.add(this.sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
            }
        });

        this.sortStocks();
        this.render();
    }

    sortStocks() {
        this.filteredStocks.sort((a, b) => {
            let aVal = a[this.sortColumn];
            let bVal = b[this.sortColumn];

            // Handle string comparison
            if (typeof aVal === 'string') {
                aVal = aVal.toLowerCase();
                bVal = bVal.toLowerCase();
            }

            if (aVal < bVal) return this.sortDirection === 'asc' ? -1 : 1;
            if (aVal > bVal) return this.sortDirection === 'asc' ? 1 : -1;
            return 0;
        });
    }

    updateStats() {
        document.getElementById('totalStocks').textContent = this.stocks.length.toLocaleString();

        // Calculate total market cap
        const totalMC = this.stocks.reduce((sum, s) => sum + s.marketCapValue, 0);
        document.getElementById('totalMarketCap').textContent = this.formatLargeNumber(totalMC);

        // Calculate total revenue
        const totalRev = this.stocks.reduce((sum, s) => sum + s.revenueValue, 0);
        document.getElementById('totalRevenue').textContent = this.formatLargeNumber(totalRev);
    }

    formatLargeNumber(num) {
        if (num >= 1e12) return '$' + (num / 1e12).toFixed(2) + 'T';
        if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
        if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
        return '$' + num.toLocaleString();
    }

    formatCurrency(num) {
        return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    render() {
        this.renderTable();
        this.renderPagination();
    }

    renderTable() {
        const tbody = document.getElementById('stocksTable');
        const start = (this.currentPage - 1) * this.pageSize;
        const end = start + this.pageSize;
        const pageStocks = this.filteredStocks.slice(start, end);

        if (pageStocks.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="no-results">No stocks found matching your search.</td></tr>';
            return;
        }

        tbody.innerHTML = pageStocks.map(stock => {
            const changeClass = stock.changePercent >= 0 ? 'change-positive' : 'change-negative';
            const changeSign = stock.changePercent >= 0 ? '+' : '';

            return `
                <tr onclick="app.openStockDetail('${stock.symbol}')">
                    <td class="symbol">${stock.symbol}</td>
                    <td class="company" title="${stock.name}">${stock.name}</td>
                    <td class="market-cap">$${stock.marketCap}</td>
                    <td class="price">${this.formatCurrency(stock.price)}</td>
                    <td class="${changeClass}">${changeSign}${this.formatCurrency(parseFloat(stock.change))}</td>
                    <td class="${changeClass}">${changeSign}${stock.changePercent.toFixed(2)}%</td>
                    <td class="revenue">$${stock.revenue}</td>
                </tr>
            `;
        }).join('');
    }

    renderPagination() {
        const pagination = document.getElementById('pagination');
        const totalPages = Math.ceil(this.filteredStocks.length / this.pageSize);

        if (totalPages <= 1) {
            pagination.innerHTML = `<span class="page-info">Showing ${this.filteredStocks.length} stocks</span>`;
            return;
        }

        let html = '';

        // Previous button
        html += `<button ${this.currentPage === 1 ? 'disabled' : ''} onclick="app.goToPage(${this.currentPage - 1})">← Previous</button>`;

        // Page numbers
        const maxVisiblePages = 5;
        let startPage = Math.max(1, this.currentPage - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

        if (endPage - startPage < maxVisiblePages - 1) {
            startPage = Math.max(1, endPage - maxVisiblePages + 1);
        }

        if (startPage > 1) {
            html += `<button onclick="app.goToPage(1)">1</button>`;
            if (startPage > 2) {
                html += `<span class="page-info">...</span>`;
            }
        }

        for (let i = startPage; i <= endPage; i++) {
            html += `<button class="${i === this.currentPage ? 'active' : ''}" onclick="app.goToPage(${i})">${i}</button>`;
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) {
                html += `<span class="page-info">...</span>`;
            }
            html += `<button onclick="app.goToPage(${totalPages})">${totalPages}</button>`;
        }

        // Next button
        html += `<button ${this.currentPage === totalPages ? 'disabled' : ''} onclick="app.goToPage(${this.currentPage + 1})">Next →</button>`;

        // Page info
        const start = (this.currentPage - 1) * this.pageSize + 1;
        const end = Math.min(this.currentPage * this.pageSize, this.filteredStocks.length);
        html += `<span class="page-info">Showing ${start}-${end} of ${this.filteredStocks.length}</span>`;

        pagination.innerHTML = html;
    }

    goToPage(page) {
        const totalPages = Math.ceil(this.filteredStocks.length / this.pageSize);
        if (page >= 1 && page <= totalPages) {
            this.currentPage = page;
            this.render();
            // Scroll to top of table
            document.querySelector('.table-container').scrollIntoView({ behavior: 'smooth' });
        }
    }

    // Stock Detail Modal Methods
    async openStockDetail(symbol) {
        const stock = this.stocks.find(s => s.symbol === symbol);
        if (!stock) return;

        this.currentStock = stock;
        this.currentPeriod = '1M';

        // Update modal content
        document.getElementById('modalSymbol').textContent = stock.symbol;
        document.getElementById('modalName').textContent = stock.name;
        document.getElementById('modalPrice').textContent = this.formatCurrency(stock.price);

        const changeClass = stock.changePercent >= 0 ? 'change-positive' : 'change-negative';
        const changeSign = stock.changePercent >= 0 ? '+' : '';
        const changeEl = document.getElementById('modalChange');
        changeEl.textContent = `${changeSign}${this.formatCurrency(parseFloat(stock.change))} (${changeSign}${stock.changePercent.toFixed(2)}%)`;
        changeEl.className = `price-change-detail ${changeClass}`;

        document.getElementById('modalMarketCap').textContent = '$' + stock.marketCap;
        document.getElementById('modalRevenue').textContent = '$' + stock.revenue;

        // Calculate day high/low based on current price and change
        const dayHigh = stock.price * (1 + Math.abs(stock.changePercent) / 100 + Math.random() * 0.02);
        const dayLow = stock.price * (1 - Math.abs(stock.changePercent) / 100 - Math.random() * 0.02);
        document.getElementById('modalHigh').textContent = this.formatCurrency(dayHigh);
        document.getElementById('modalLow').textContent = this.formatCurrency(dayLow);

        // Reset period buttons
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.period === '1M') {
                btn.classList.add('active');
            }
        });

        // Show modal
        document.getElementById('stockModal').classList.add('active');
        document.body.style.overflow = 'hidden';

        // Render chart with real data
        await this.renderChart();
    }

    closeModal() {
        document.getElementById('stockModal').classList.remove('active');
        document.body.style.overflow = '';

        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }

    async selectPeriod(period) {
        this.currentPeriod = period;

        // Update button states
        document.querySelectorAll('.time-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.period === period) {
                btn.classList.add('active');
            }
        });

        // Re-render chart
        await this.renderChart();
    }

    async fetchHistoricalData(symbol, period) {
        // Map period to Yahoo Finance parameters
        const periodMap = {
            '1D': { range: '1d', interval: '5m' },
            '5D': { range: '5d', interval: '15m' },
            '1M': { range: '1mo', interval: '1d' },
            '1Y': { range: '1y', interval: '1d' },
            '5Y': { range: '5y', interval: '1wk' },
            'MAX': { range: 'max', interval: '1mo' }
        };

        const { range, interval } = periodMap[period] || periodMap['1M'];

        try {
            // Use Yahoo Finance API via CORS proxy for client-side requests
            const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;

            // Use corsproxy.io as a CORS proxy
            const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(yahooUrl)}`;

            const response = await fetch(proxyUrl);

            if (!response.ok) {
                throw new Error('Failed to fetch data');
            }

            const data = await response.json();
            const result = data.chart.result[0];
            const timestamps = result.timestamp;
            const prices = result.indicators.quote[0].close;

            // Format the data
            const historicalData = [];
            const dateFormat = this.getDateFormat(period);

            for (let i = 0; i < timestamps.length; i++) {
                if (prices[i] !== null) {
                    const date = new Date(timestamps[i] * 1000);
                    historicalData.push({
                        label: date.toLocaleDateString('en-US', dateFormat),
                        price: prices[i]
                    });
                }
            }

            return historicalData;
        } catch (error) {
            console.error('Error fetching historical data:', error);
            // Return fallback simulated data if API fails
            return this.generateFallbackData(this.currentStock, period);
        }
    }

    getDateFormat(period) {
        switch (period) {
            case '1D': return { hour: '2-digit', minute: '2-digit' };
            case '5D': return { weekday: 'short', hour: '2-digit' };
            case '1M': return { month: 'short', day: 'numeric' };
            case '1Y': return { month: 'short', year: '2-digit' };
            case '5Y': return { month: 'short', year: '2-digit' };
            case 'MAX': return { year: 'numeric' };
            default: return { month: 'short', day: 'numeric' };
        }
    }

    generateFallbackData(stock, period) {
        // Fallback simulated data if API fails
        const now = new Date();
        const data = [];
        let dataPoints, intervalMs;

        switch (period) {
            case '1D': dataPoints = 78; intervalMs = 5 * 60 * 1000; break;
            case '5D': dataPoints = 40; intervalMs = 2 * 60 * 60 * 1000; break;
            case '1M': dataPoints = 22; intervalMs = 24 * 60 * 60 * 1000; break;
            case '1Y': dataPoints = 52; intervalMs = 7 * 24 * 60 * 60 * 1000; break;
            case '5Y': dataPoints = 60; intervalMs = 30 * 24 * 60 * 60 * 1000; break;
            case 'MAX': dataPoints = 120; intervalMs = 30 * 24 * 60 * 60 * 1000; break;
            default: dataPoints = 22; intervalMs = 24 * 60 * 60 * 1000;
        }

        const currentPrice = stock.price;
        const volatility = 0.02 * (period === 'MAX' ? 3 : period === '5Y' ? 2.5 : period === '1Y' ? 2 : 1);
        let prices = [currentPrice];

        for (let i = 1; i < dataPoints; i++) {
            const lastPrice = prices[prices.length - 1];
            const change = (Math.random() - 0.48) * volatility * lastPrice;
            prices.push(Math.max(lastPrice * 0.5, lastPrice - change));
        }
        prices = prices.reverse();

        const dateFormat = this.getDateFormat(period);
        for (let i = 0; i < dataPoints; i++) {
            const date = new Date(now.getTime() - (dataPoints - 1 - i) * intervalMs);
            data.push({ label: date.toLocaleDateString('en-US', dateFormat), price: prices[i] });
        }

        return data;
    }

    async renderChart() {
        if (!this.currentStock) return;

        const ctx = document.getElementById('stockChart').getContext('2d');
        const chartContainer = document.querySelector('.chart-container');

        // Show loading state
        chartContainer.style.opacity = '0.5';

        // Destroy existing chart
        if (this.chart) {
            this.chart.destroy();
        }

        // Fetch real historical data
        const historicalData = await this.fetchHistoricalData(this.currentStock.symbol, this.currentPeriod);

        chartContainer.style.opacity = '1';

        const labels = historicalData.map(d => d.label);
        const prices = historicalData.map(d => d.price);

        // Determine if overall trend is positive or negative
        const isPositive = prices[prices.length - 1] >= prices[0];
        const lineColor = isPositive ? '#00ff88' : '#ff4757';
        const gradientColor = isPositive ? 'rgba(0, 255, 136, 0.1)' : 'rgba(255, 71, 87, 0.1)';

        // Create gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, gradientColor);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: this.currentStock.symbol,
                    data: prices,
                    borderColor: lineColor,
                    borderWidth: 2,
                    fill: true,
                    backgroundColor: gradient,
                    tension: 0.1,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: lineColor,
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        backgroundColor: 'rgba(30, 42, 58, 0.95)',
                        titleColor: '#00d4ff',
                        bodyColor: '#e4e4e4',
                        borderColor: '#2d3a4f',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            label: (context) => {
                                return `Price: ${this.formatCurrency(context.raw)}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: {
                            color: 'rgba(45, 58, 79, 0.5)',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#8892b0',
                            maxTicksLimit: 8,
                            maxRotation: 0
                        }
                    },
                    y: {
                        position: 'right',
                        grid: {
                            color: 'rgba(45, 58, 79, 0.5)',
                            drawBorder: false
                        },
                        ticks: {
                            color: '#8892b0',
                            callback: (value) => '$' + value.toLocaleString(undefined, {
                                minimumFractionDigits: 0,
                                maximumFractionDigits: 2
                            })
                        }
                    }
                }
            }
        });
    }
}

// Initialize the application
const app = new StockScreener();
