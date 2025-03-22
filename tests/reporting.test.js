/**
 * Tests for the reporting module
 */
const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { 
  generateReport, 
  generateNicheSummaryReport, 
  formatNumber, 
  formatDate 
} = require('../src/reporting');

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

describe('Reporting Module', () => {
  let mockPool;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Get references to the mocked instances
    mockPool = new Pool();
    mockClient = mockPool.connect();
  });

  describe('generateReport', () => {
    const mockSiteData = [
      {
        id: '12345',
        domain_name: 'example.com',
        niche: 'indoor hydroponics',
        created_at: '2023-01-15T10:00:00Z',
        status: 'active',
        monthly_traffic: 5000,
        unique_visitors: 3500,
        page_views: 15000,
        avg_session_duration: 125.5,
        monthly_revenue: 1250.75,
        affiliate_earnings: 950.50,
        ad_revenue: 300.25,
        conversion_rate: 2.35,
        click_through_rate: 3.75,
        total_backlinks: 150,
        referring_domains: 45,
        content_count: 35,
        avg_seo_score: 78.5,
        last_updated: '2023-02-01T14:30:00Z'
      },
      {
        id: '67890',
        domain_name: 'anothersite.org',
        niche: 'organic gardening',
        created_at: '2023-02-20T08:15:00Z',
        status: 'active',
        monthly_traffic: 3200,
        unique_visitors: 2100,
        page_views: 8900,
        avg_session_duration: 95.2,
        monthly_revenue: 850.25,
        affiliate_earnings: 620.10,
        ad_revenue: 230.15,
        conversion_rate: 1.95,
        click_through_rate: 2.85,
        total_backlinks: 85,
        referring_domains: 28,
        content_count: 22,
        avg_seo_score: 72.0,
        last_updated: '2023-03-05T11:45:00Z'
      }
    ];

    test('should successfully generate a performance report', async () => {
      // Setup mock database response
      mockClient.query.mockResolvedValueOnce({ 
        rows: mockSiteData,
        rowCount: mockSiteData.length
      });

      // Execute
      const result = await generateReport({
        outputDir: './test-reports',
        filename: 'test-report.csv'
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.reportPath).toBe('./test-reports/test-report.csv');
      expect(result.recordCount).toBe(2);
      
      // Verify DB query was called with correct parameters
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        expect.any(Array)
      );
      
      // Verify CSV writer was called
      expect(createCsvWriter).toHaveBeenCalledWith({
        path: './test-reports/test-report.csv',
        header: expect.any(Array)
      });
      
      // Verify directory creation was attempted
      expect(fs.mkdir).toHaveBeenCalledWith('./test-reports', { recursive: true });
      
      // Verify client was released
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('should handle database errors gracefully', async () => {
      // Setup mock database error
      const dbError = new Error('Database connection failed');
      mockClient.query.mockRejectedValueOnce(dbError);

      // Execute
      const result = await generateReport();

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Database connection failed');
      expect(mockClient.release).toHaveBeenCalled();
    });

    test('should filter metrics based on options', async () => {
      // Setup mock database response
      mockClient.query.mockResolvedValueOnce({ 
        rows: mockSiteData,
        rowCount: mockSiteData.length
      });

      // Execute with specific metrics
      const result = await generateReport({
        metrics: ['traffic', 'revenue'] // Only request traffic and revenue metrics
      });

      // Assert
      expect(result.success).toBe(true);
      
      // Verify query contained the right metrics
      const queryCall = mockClient.query.mock.calls[0][0];
      expect(queryCall).toContain('monthly_traffic');
      expect(queryCall).toContain('monthly_revenue');
      
      // Should not include unspecified metrics in SELECT
      expect(queryCall).not.toContain('total_backlinks');
    });

    test('should handle empty result set', async () => {
      // Setup mock empty database response
      mockClient.query.mockResolvedValueOnce({ 
        rows: [],
        rowCount: 0
      });

      // Execute
      const result = await generateReport();

      // Assert
      expect(result.success).toBe(true);
      expect(result.recordCount).toBe(0);
      
      // CSV writer should not be called with empty data
      expect(createCsvWriter().writeRecords).not.toHaveBeenCalled();
    });
  });

  describe('generateNicheSummaryReport', () => {
    const mockNicheSummaryData = [
      {
        niche: 'indoor hydroponics',
        site_count: 15,
        total_traffic: 75000,
        avg_traffic_per_site: 5000,
        total_revenue: 18750.50,
        avg_revenue_per_site: 1250.70,
        avg_conversion_rate: 2.15,
        total_content_count: 525,
        avg_content_per_site: 35,
        avg_seo_score: 77.5
      },
      {
        niche: 'organic gardening',
        site_count: 8,
        total_traffic: 25600,
        avg_traffic_per_site: 3200,
        total_revenue: 6802.00,
        avg_revenue_per_site: 850.25,
        avg_conversion_rate: 1.95,
        total_content_count: 176,
        avg_content_per_site: 22,
        avg_seo_score: 72.0
      }
    ];

    test('should successfully generate a niche summary report', async () => {
      // Setup mock database response
      mockClient.query.mockResolvedValueOnce({
        rows: mockNicheSummaryData,
        rowCount: mockNicheSummaryData.length
      });

      // Execute
      const result = await generateNicheSummaryReport({
        outputDir: './test-reports',
        filename: 'niche-summary.csv'
      });

      // Assert
      expect(result.success).toBe(true);
      expect(result.reportPath).toBe('./test-reports/niche-summary.csv');
      expect(result.recordCount).toBe(2);
      
      // Verify correct query structure
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('GROUP BY s.niche'),
        expect.any(Array)
      );
      
      // Verify CSV writer was called
      expect(createCsvWriter).toHaveBeenCalledWith({
        path: './test-reports/niche-summary.csv',
        header: expect.any(Array)
      });
    });

    test('should handle database errors in summary report', async () => {
      // Setup mock database error
      const dbError = new Error('Query execution failed');
      mockClient.query.mockRejectedValueOnce(dbError);

      // Execute
      const result = await generateNicheSummaryReport();

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Query execution failed');
    });
  });

  describe('Utility Functions', () => {
    describe('formatNumber', () => {
      test('should format numbers to specified decimal places', () => {
        expect(formatNumber(123.4567)).toBe(123.46);
        expect(formatNumber(123.4567, 3)).toBe(123.457);
        expect(formatNumber(123, 0)).toBe(123);
      });

      test('should handle null, undefined and NaN values', () => {
        expect(formatNumber(null)).toBe(0);
        expect(formatNumber(undefined)).toBe(0);
        expect(formatNumber('not a number')).toBe(0);
      });
    });

    describe('formatDate', () => {
      test('should format dates to ISO string by default', () => {
        const date = new Date('2023-05-15T10:30:00Z');
        expect(formatDate(date)).toBe('2023-05-15T10:30:00.000Z');
      });

      test('should format dates to short format when specified', () => {
        const date = new Date('2023-05-15T10:30:00Z');
        expect(formatDate(date, 'short')).toBe('2023-05-15');
      });

      test('should handle invalid date inputs', () => {
        expect(formatDate(null)).toBe('');
        expect(formatDate('not a date')).toBe('');
      });
    });
  });
});
