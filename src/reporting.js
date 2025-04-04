/**
 * SiteGenie Reporting Module
 * Generates performance reports for niche websites
 */
const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const logger = require('./utils/logger'); // Assuming logger utility exists

// Database configuration - would typically be imported from a config file
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'sitegenie',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
};

// Initialize PostgreSQL connection pool
const pool = new Pool(dbConfig);

/**
 * Formats a numeric value with specified decimal places
 * 
 * @param {number} value - The value to format
 * @param {number} decimals - Number of decimal places
 * @returns {number} - Formatted number
 */
function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined) return 0;
  const numValue = parseFloat(value);
  return isNaN(numValue) ? 0 : parseFloat(numValue.toFixed(decimals));
}

/**
 * Formats a date value to ISO string or specified format
 * 
 * @param {Date|string} dateValue - The date to format
 * @param {string} [format='iso'] - Output format ('iso' or 'short')
 * @returns {string} - Formatted date string
 */
function formatDate(dateValue, format = 'iso') {
  if (!dateValue) return '';
  const date = new Date(dateValue);
  if (isNaN(date.getTime())) return '';
  
  switch(format) {
    case 'short':
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    case 'iso':
    default:
      return date.toISOString();
  }
}

/**
 * Ensures that the specified directory exists
 * 
 * @param {string} dirPath - Path to the directory
 * @returns {Promise<void>}
 */
async function ensureDirectoryExists(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Generates a performance report for niche websites
 * 
 * @param {Object} options - Report generation options
 * @param {string} [options.outputDir='./reports'] - Directory to save the report
 * @param {string} [options.filename] - Custom filename (default: niche-performance-YYYY-MM-DD.csv)
 * @param {Date} [options.startDate] - Start date for report data
 * @param {Date} [options.endDate] - End date for report data
 * @param {string} [options.format='csv'] - Output format ('csv' only for now)
 * @param {string[]} [options.metrics] - Specific metrics to include
 * @returns {Promise<Object>} - Report generation results
 */
async function generateReport(options = {}) {
  const {
    outputDir = './reports',
    filename = `niche-performance-${new Date().toISOString().split('T')[0]}.csv`,
    startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Default: last 30 days
    endDate = new Date(),
    format = 'csv',
    metrics = ['traffic', 'revenue', 'conversion_rate', 'backlinks']
  } = options;

  const outputPath = path.join(outputDir, filename);
  let client;
  
  try {
    // Ensure reports directory exists
    await ensureDirectoryExists(outputDir);
    
    // Connect to database
    client = await pool.connect();
    logger.info('Connected to database for report generation');
    
    // Construct SQL query based on requested metrics
    let metricsColumns = [];
    if (metrics.includes('traffic')) {
      metricsColumns.push('monthly_traffic', 'unique_visitors', 'page_views', 'avg_session_duration');
    }
    if (metrics.includes('revenue')) {
      metricsColumns.push('monthly_revenue', 'affiliate_earnings', 'ad_revenue');
    }
    if (metrics.includes('conversion_rate')) {
      metricsColumns.push('conversion_rate', 'click_through_rate');
    }
    if (metrics.includes('backlinks')) {
      metricsColumns.push('total_backlinks', 'referring_domains');
    }
    
    // Fallback to basic metrics if none selected
    if (metricsColumns.length === 0) {
      metricsColumns = ['monthly_traffic', 'monthly_revenue'];
    }
    
    // Define SQL query for site performance data
    const query = `
      SELECT 
        s.id,
        s.domain_name,
        s.niche,
        s.created_at,
        s.status,
        ${metricsColumns.join(', ')},
        (SELECT COUNT(*) FROM content c WHERE c.site_id = s.id) AS content_count,
        (SELECT AVG(seo_score) FROM content c WHERE c.site_id = s.id) AS avg_seo_score,
        p.last_updated
      FROM 
        sites s
      LEFT JOIN 
        performance_metrics p ON s.id = p.site_id
      WHERE 
        p.date_recorded BETWEEN $1 AND $2
      GROUP BY 
        s.id, p.last_updated
      ORDER BY 
        s.created_at DESC
    `;
    
    // Execute query
    const result = await client.query(query, [startDate.toISOString(), endDate.toISOString()]);
    logger.info(`Retrieved performance data for ${result.rows.length} sites`);
    
    // Process data
    const processedData = result.rows.map(row => {
      const processedRow = {
        site_id: row.id,
        domain: row.domain_name,
        niche: row.niche,
        status: row.status,
        created_at: formatDate(row.created_at),
        content_count: parseInt(row.content_count || 0, 10),
        avg_seo_score: formatNumber(row.avg_seo_score),
        last_updated: formatDate(row.last_updated)
      };
      
      // Add metrics based on what was requested
      if (metrics.includes('traffic')) {
        processedRow.monthly_traffic = parseInt(row.monthly_traffic || 0, 10);
        processedRow.unique_visitors = parseInt(row.unique_visitors || 0, 10);
        processedRow.page_views = parseInt(row.page_views || 0, 10);
        processedRow.avg_session_duration = formatNumber(row.avg_session_duration);
      }
      
      if (metrics.includes('revenue')) {
        processedRow.monthly_revenue = formatNumber(row.monthly_revenue);
        processedRow.affiliate_earnings = formatNumber(row.affiliate_earnings);
        processedRow.ad_revenue = formatNumber(row.ad_revenue);
      }
      
      if (metrics.includes('conversion_rate')) {
        processedRow.conversion_rate = formatNumber(row.conversion_rate);
        processedRow.click_through_rate = formatNumber(row.click_through_rate);
      }
      
      if (metrics.includes('backlinks')) {
        processedRow.total_backlinks = parseInt(row.total_backlinks || 0, 10);
        processedRow.referring_domains = parseInt(row.referring_domains || 0, 10);
      }
      
      return processedRow;
    });
    
    // Define CSV header
    const headers = Object.keys(processedData[0] || {}).map(key => ({
      id: key,
      title: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }));
    
    // Write to CSV
    const csvWriter = createCsvWriter({
      path: outputPath,
      header: headers
    });
    
    await csvWriter.writeRecords(processedData);
    logger.info(`Report generated successfully at ${outputPath}`);
    
    // Return report information
    return {
      success: true,
      reportPath: outputPath,
      format,
      recordCount: processedData.length,
      startDate: formatDate(startDate),
      endDate: formatDate(endDate),
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to generate report:', error);
    
    return {
      success: false,
      error: error.message,
      details: error.stack,
      outputPath
    };
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Generates a summary report with aggregated data by niche
 * 
 * @param {Object} options - Report generation options
 * @param {string} [options.outputDir='./reports'] - Directory to save the report
 * @param {string} [options.filename] - Custom filename (default: niche-summary-YYYY-MM-DD.csv)
 * @param {Date} [options.startDate] - Start date for report data
 * @param {Date} [options.endDate] - End date for report data
 * @returns {Promise<Object>} - Report generation results
 */
async function generateNicheSummaryReport(options = {}) {
  const {
    outputDir = './reports',
    filename = `niche-summary-${new Date().toISOString().split('T')[0]}.csv`,
    startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Default: last 30 days
    endDate = new Date()
  } = options;

  const outputPath = path.join(outputDir, filename);
  let client;
  
  try {
    // Ensure reports directory exists
    await ensureDirectoryExists(outputDir);
    
    // Connect to database
    client = await pool.connect();
    
    // Query for aggregated niche data
    const query = `
      SELECT 
        s.niche,
        COUNT(DISTINCT s.id) AS site_count,
        SUM(p.monthly_traffic) AS total_traffic,
        AVG(p.monthly_traffic) AS avg_traffic_per_site,
        SUM(p.monthly_revenue) AS total_revenue,
        AVG(p.monthly_revenue) AS avg_revenue_per_site,
        AVG(p.conversion_rate) AS avg_conversion_rate,
        SUM(
          (SELECT COUNT(*) FROM content c WHERE c.site_id = s.id)
        ) AS total_content_count,
        AVG(
          (SELECT COUNT(*) FROM content c WHERE c.site_id = s.id)
        ) AS avg_content_per_site,
        AVG(
          (SELECT AVG(seo_score) FROM content c WHERE c.site_id = s.id)
        ) AS avg_seo_score
      FROM 
        sites s
      LEFT JOIN 
        performance_metrics p ON s.id = p.site_id
      WHERE 
        p.date_recorded BETWEEN $1 AND $2
      GROUP BY 
        s.niche
      ORDER BY 
        total_revenue DESC
    `;
    
    // Execute query
    const result = await client.query(query, [startDate.toISOString(), endDate.toISOString()]);
    logger.info(`Generated summary data for ${result.rows.length} niches`);
    
    // Process data
    const processedData = result.rows.map(row => ({
      niche: row.niche,
      site_count: parseInt(row.site_count, 10),
      total_traffic: parseInt(row.total_traffic || 0, 10),
      avg_traffic_per_site: formatNumber(row.avg_traffic_per_site),
      total_revenue: formatNumber(row.total_revenue),
      avg_revenue_per_site: formatNumber(row.avg_revenue_per_site),
      avg_conversion_rate: formatNumber(row.avg_conversion_rate),
      total_content_count: parseInt(row.total_content_count || 0, 10),
      avg_content_per_site: formatNumber(row.avg_content_per_site),
      avg_seo_score: formatNumber(row.avg_seo_score),
      roi_score: formatNumber(
        (row.avg_revenue_per_site || 0) / (row.avg_traffic_per_site || 1) * 1000
      ) // Revenue per 1000 visitors as ROI score
    }));
    
    // Define CSV header
    const headers = Object.keys(processedData[0] || {}).map(key => ({
      id: key,
      title: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }));
    
    // Write to CSV
    const csvWriter = createCsvWriter({
      path: outputPath,
      header: headers
    });
    
    await csvWriter.writeRecords(processedData);
    logger.info(`Niche summary report generated successfully at ${outputPath}`);
    
    // Return report information
    return {
      success: true,
      reportPath: outputPath,
      recordCount: processedData.length,
      startDate: formatDate(startDate),
      endDate: formatDate(endDate),
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to generate niche summary report:', error);
    
    return {
      success: false,
      error: error.message,
      details: error.stack,
      outputPath
    };
  } finally {
    if (client) {
      client.release();
    }
  }
}

module.exports = {
  generateReport,
  generateNicheSummaryReport,
  formatNumber,
  formatDate
};
