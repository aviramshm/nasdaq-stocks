// NASDAQ Stock Screener Application

class StockScreener {
    constructor() {
        this.stocks = stocksData;
        this.filteredStocks = [...this.stocks];
        this.currentPage = 1;
        this.pageSize = 50;
        this.sortColumn = 'marketCapValue';
        this.sortDirection = 'desc';

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
                <tr>
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
}

// Initialize the application
const app = new StockScreener();
