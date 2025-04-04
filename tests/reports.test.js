/**
 * Tests for the Reports module
 */
const { Pool } = require('pg');
const { 
  getNichePerformanceData, 
  generateReport, 
  generateNicheComparisonReport 
} = require('../src/reports');

// Mock dependencies
jest.mock('pg', () => {
  const mockPool = {
    connect: jest.fn(),
    end: jest.fn()
  };
  const mockClient = {
    query: jest.fn(),
    release: jest.fn()
  };
  return {
    Pool: jest.fn(() => ({
      ...mockPool,
      connect: jest.fn().mockResolvedValue(mockClient)
    }))
  };
});

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock('path', () => ({
  join: jest.fn((dir, file) => `${dir}/${file}`)
}));

jest.mock('csv-writer', () => ({
  createObjectCsvWriter: jest.fn().mockReturnValue({
    writeRecords: jest.fn().mockResolvedValue(undefined)
  })
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

describe('Reports Module', () => {
  let mockPool;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Get references to the mocked instances
    mockPool = new Pool();
    mockClient = mockPool.connect();
  });

  describe('getNichePerformanceData', () => {
    // Sample niche data that would be returned from the database
    const mockNicheData = [
      {
        id: 'niche1',
        name: 'Indoor Hydroponics',
        competition_score: 35.5,
        trending_score: 7.8,
        total_traffic: 25000,
        avg_traffic: 5000,
        total_visitors: 18000,
        site_count: 5,
        total_revenue: 15000.75,
        avg_revenue: 3000.15,
        total_affiliate_earnings: 12500.50,
        total_ad_revenue: 2500.25,
        avg_domain_authority: 42.5,
        total_backlinks: 5000,
        avg_organic_keywords: 1200,
        total_content: 85,
        avg_content_score: 78.5
      },
      {
        id: 'niche2',
        name: 'Organic Gardening',
        competition_score: 42.3,
        trending_score: 6.5,
        total_traffic: 18000,
        avg_traffic: 3600,
        total_visitors: 14000,
        site_count: 5,
        total_revenue: 12000.50,
        avg_revenue: 2400.10,
        total_affiliate_earnings: 9500.25,
        total_ad_revenue: 2500.25,
        avg_domain_authority: 38.7,
        total_backlinks: 3200,
        avg_organic_keywords: 980,
        total_content: 65,
        avg_content_score: 72.3
      }
    ];

    test('should retrieve niche performance data with default options', async () => {
      // Setup mock database response
      mockClient.query.mockResolvedValueOnce({ 
        rows: mockNicheData, 
        rowCount: mockNicheData.length 
      });
      
      // Execute with default options
      const result = await getNichePerformanceData();
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.data.length).toBe(2);
      expect(result.count).toBe(2);
      
      // Check that query used correct default date range (30 days)
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.any(String), expect.any(String)])
      );
      
      // Verify client was released
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('should include requested metrics in the query', async () => {
      // Setup mock
      mockClient.query.mockResolvedValueOnce({ 
        rows: mockNicheData, 
        rowCount: mockNicheData.length 
      });
      
      // Execute with specific metrics
      await getNichePerformanceData({
        metrics: ['traffic', 'revenue']
      });
      
      // Verify query includes requested metrics but not others
      const queryString = mockClient.query.mock.calls[0][0];
      expect(queryString).toContain('SUM(s.monthly_traffic)');
      expect(queryString).toContain('SUM(s.monthly_revenue)');
      expect(queryString).not.toContain('AVG(s.domain_authority)'); // seo metric not requested
    });

    test('should format numeric values correctly', async () => {
      // Setup
      mockClient.query.mockResolvedValueOnce({ 
        rows: mockNicheData, 
        rowCount: mockNicheData.length 
      });
      
      // Execute
      const result = await getNichePerformanceData();
      
      // Assert formatting of different numeric types
      const niche = result.data[0];
      
      // Integer values
      expect(Number.isInteger(niche.total_traffic)).toBe(true);
      expect(Number.isInteger(niche.site_count)).toBe(true);
      expect(Number.isInteger(niche.total_backlinks)).toBe(true);
      
      // Decimal values formatted to 2 places
      const decimalRegex = /^\d+\.\d{2}$/;
      expect(niche.avg_revenue.toString()).toMatch(decimalRegex);
      expect(niche.total_affiliate_earnings.toString()).toMatch(decimalRegex);
      
      // Check calculated fields
      if (niche.revenue_per_visitor) {
        expect(niche.revenue_per_visitor.toString()).toMatch(decimalRegex);
      }
      if (niche.profit_efficiency_score) {
        expect(niche.profit_efficiency_score.toString()).toMatch(decimalRegex);
      }
    });

    test('should handle database query errors', async () => {
      // Setup - mock database error
      const dbError = new Error('Database connection failed');
      mockClient.query.mockRejectedValueOnce(dbError);
      
      // Execute
      const result = await getNichePerformanceData();
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Database connection failed');
      
      // Verify client was still released despite the error
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('should handle empty result set', async () => {
      // Setup - mock empty response
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      
      // Execute
      const result = await getNichePerformanceData();
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
      expect(result.count).toBe(0);
    });

    test('should respect custom date ranges', async () => {
      // Setup
      mockClient.query.mockResolvedValueOnce({ 
        rows: mockNicheData, 
        rowCount: mockNicheData.length 
      });
      
      // Custom date range
      const startDate = new Date('2023-01-01');
      const endDate = new Date('2023-03-31');
      
      // Execute
      await getNichePerformanceData({
        startDate,
        endDate
      });
      
      // Check that query used our custom date range
      const queryParams = mockClient.query.mock.calls[0][1];
      expect(queryParams[0]).toEqual(startDate.toISOString());
      expect(queryParams[1]).toEqual(endDate.toISOString());
    });
  });

  describe('generateReport', () => {
    test('should generate a report successfully', async () => {
      // Setup - mock successful data retrieval
      mockClient.query.mockResolvedValueOnce({ 
        rows: [
          {
            id: 'niche1',
            name: 'Test Niche',
            competition_score: 35.5,
            total_traffic: 10000
          }
        ], 
        rowCount: 1
      });
      
      // Execute
      const result = await generateReport({
        outputDir: './test-reports',
        filename: 'test-report.csv'
      });
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.reportPath).toBe('./test-reports/test-report.csv');
      expect(result.recordCount).toBe(1);
    });

    test('should handle case when no data is available', async () => {
      // Setup - data retrieval succeeds but returns empty array
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      
      // Execute
      const result = await generateReport();
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('No data available');
    });

    test('should handle data retrieval errors', async () => {
      // Setup - mock data retrieval failure
      mockClient.query.mockRejectedValueOnce(new Error('Database error'));
      
      // Execute
      const result = await generateReport();
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to retrieve niche data');
    });
  });

  describe('generateNicheComparisonReport', () => {
    const mockComparisonData = [
      {
        id: 'niche1',
        name: 'Niche One',
        competition_score: 35,
        monetization_potential: 7.5,
        trending_score: 8.2,
        site_count: 5,
        avg_traffic: 5000,
        max_traffic: 12000,
        total_revenue: 15000,
        avg_revenue: 3000,
        avg_conversion_rate: 2.5,
        avg_domain_authority: 40,
        total_backlinks: 5000,
        avg_content_score: 75,
        total_content_count: 80
      },
      {
        id: 'niche2',
        name: 'Niche Two',
        competition_score: 42,
        monetization_potential: 6.8,
        trending_score: 7.5,
        site_count: 4,
        avg_traffic: 4200,
        max_traffic: 9500,
        total_revenue: 12000,
        avg_revenue: 3000,
        avg_conversion_rate: 2.2,
        avg_domain_authority: 38,
        total_backlinks: 4200,
        avg_content_score: 72,
        total_content_count: 65
      }
    ];

    test('should generate a comparison report successfully', async () => {
      // Setup - mock successful comparison data retrieval
      mockClient.query.mockResolvedValueOnce({ 
        rows: mockComparisonData, 
        rowCount: 2
      });
      
      // Execute
      const result = await generateNicheComparisonReport('niche1', 'niche2', {
        outputDir: './test-reports',
        filename: 'comparison-report.csv'
      });
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.reportPath).toBe('./test-reports/comparison-report.csv');
      expect(result.niche1.id).toBe('niche1');
      expect(result.niche2.id).toBe('niche2');
    });

    test('should handle case when data for both niches is not available', async () => {
      // Setup - data retrieval returns only one niche
      mockClient.query.mockResolvedValueOnce({ 
        rows: [mockComparisonData[0]], 
        rowCount: 1
      });
      
      // Execute
      const result = await generateNicheComparisonReport('niche1', 'niche2');
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not retrieve data for both niches');
    });

    test('should handle database errors', async () => {
      // Setup - mock database error
      mockClient.query.mockRejectedValueOnce(new Error('Connection failed'));
      
      // Execute
      const result = await generateNicheComparisonReport('niche1', 'niche2');
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection failed');
      
      // Verify client was still released
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('should apply correct date range based on timeframe', async () => {
      // Setup
      mockClient.query.mockResolvedValueOnce({ 
        rows: mockComparisonData, 
        rowCount: 2
      });
      
      // Execute with specific timeframe
      await generateNicheComparisonReport('niche1', 'niche2', {
        timeframe: 'last_30_days'
      });
      
      // Get the query parameters
      const queryParams = mockClient.query.mock.calls[0][1];
      const startDateStr = queryParams[2]; // Index 2 is the start date
      const endDateStr = queryParams[3]; // Index 3 is the end date
      
      // Convert strings to dates for comparison
      const startDate = new Date(startDateStr);
      const endDate = new Date(endDateStr);
      
      // Calculate expected date range (30 days)
      const expectedDiff = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
      const actualDiff = endDate.getTime() - startDate.getTime();
      
      // Allow for 1 minute difference to account for test execution time
      const tolerance = 60 * 1000; // 1 minute in milliseconds
      
      // Verify correct date range with tolerance
      expect(Math.abs(actualDiff - expectedDiff)).toBeLessThan(tolerance);
    });
  });
});
