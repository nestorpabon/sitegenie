/**
 * SiteGenie Reports Module
 * Handles generation and retrieval of niche performance reports
 */
const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const logger = require('./utils/logger'); // Assuming a logger utility exists

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'sitegenie',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
};

// Initialize database connection pool
const pool = new Pool(dbConfig);

/**
 * Retrieve performance data for all niches
 * 
 * @param {Object} options - Query options
 * @param {Date} [options.startDate] - Start date for data retrieval (default: 30 days ago)
 * @param {Date} [options.endDate] - End date for data retrieval (default: current date)
 * @param {string[]} [options.metrics] - Specific metrics to include
 * @returns {Promise<Object>} - Object containing niche performance data
 */
async function getNichePerformanceData(options = {}) {
  const {
    startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Default: last 30 days
    endDate = new Date(),
    metrics = ['traffic', 'revenue', 'seo', 'content']
  } = options;
  
  let client;
  
  try {
    client = await pool.connect();
    logger.info('Connected to database for niche performance data retrieval');
    
    // Build columns based on requested metrics
    let columns = ['n.id', 'n.name', 'n.competition_score', 'n.trending_score'];
    
    if (metrics.includes('traffic')) {
      columns.push(
        'SUM(s.monthly_traffic) as total_traffic',
        'AVG(s.monthly_traffic) as avg_traffic',
        'SUM(s.unique_visitors) as total_visitors',
        'COUNT(DISTINCT s.id) as site_count'
      );
    }
    
    if (metrics.includes('revenue')) {
      columns.push(
        'SUM(s.monthly_revenue) as total_revenue',
        'AVG(s.monthly_revenue) as avg_revenue',
        'SUM(s.affiliate_earnings) as total_affiliate_earnings',
        'SUM(s.ad_revenue) as total_ad_revenue'
      );
    }
    
    if (metrics.includes('seo')) {
      columns.push(
        'AVG(s.domain_authority) as avg_domain_authority',
        'SUM(s.total_backlinks) as total_backlinks',
        'AVG(s.organic_keywords) as avg_organic_keywords'
      );
    }
    
    if (metrics.includes('content')) {
      columns.push(
        '(SELECT COUNT(*) FROM content c WHERE c.site_id = s.id) as total_content',
        '(SELECT AVG(c.seo_score) FROM content c WHERE c.site_id = s.id) as avg_content_score'
      );
    }
    
    const query = `
      SELECT ${columns.join(', ')}
      FROM niches n
      LEFT JOIN sites s ON n.id = s.niche_id
      WHERE s.created_at BETWEEN $1 AND $2
      GROUP BY n.id, n.name, n.competition_score, n.trending_score
      ORDER BY total_revenue DESC NULLS LAST
    `;
    
    const result = await client.query(query, [startDate.toISOString(), endDate.toISOString()]);
    logger.info(`Retrieved performance data for ${result.rows.length} niches`);
    
    // Process and format the data
    const formattedData = result.rows.map(row => {
      // Format numeric values
      Object.keys(row).forEach(key => {
        if (typeof row[key] === 'number') {
          // Format decimal values to 2 decimal places
          if (key.includes('revenue') || key.includes('earnings') || key.includes('score')) {
            row[key] = parseFloat(row[key].toFixed(2));
          } 
          // Format integer values
          else if (key.includes('count') || key.includes('traffic') || key.includes('visitors') || key.includes('backlinks')) {
            row[key] = parseInt(row[key], 10);
          }
        }
      });
      
      // Add calculated metrics
      if (row.total_revenue && row.total_traffic) {
        row.revenue_per_visitor = parseFloat((row.total_revenue / row.total_traffic).toFixed(2));
      }
      
      if (row.avg_revenue && row.avg_traffic) {
        row.profit_efficiency_score = parseFloat((row.avg_revenue / (row.competition_score || 1) * 10).toFixed(2));
      }
      
      return row;
    });
    
    return {
      success: true,
      data: formattedData,
      count: formattedData.length,
      dateRange: {
        start: startDate.toISOString(),
        end: endDate.toISOString()
      }
    };
  } catch (error) {
    logger.error('Failed to retrieve niche performance data:', error);
    
    return {
      success: false,
      error: error.message,
      details: error.stack
    };
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Generate a CSV report for niche performance
 * 
 * @param {Object} options - Report options
 * @param {string} [options.outputDir='./reports'] - Directory to save the report
 * @param {string} [options.filename] - Custom filename (default: niche-performance-YYYY-MM-DD.csv)
 * @param {Date} [options.startDate] - Start date for report data
 * @param {Date} [options.endDate] - End date for report data
 * @param {string[]} [options.metrics] - Specific metrics to include
 * @param {boolean} [options.includeHeaders=true] - Whether to include headers in CSV
 * @returns {Promise<Object>} - Report generation result
 */
async function generateReport(options = {}) {
  const {
    outputDir = './reports',
    filename = `niche-performance-${new Date().toISOString().split('T')[0]}.csv`,
    startDate,
    endDate,
    metrics,
    includeHeaders = true
  } = options;
  
  const outputPath = path.join(outputDir, filename);
  
  try {
    // Ensure the reports directory exists
    await fs.mkdir(outputDir, { recursive: true });
    
    // Get niche performance data
    const performanceData = await getNichePerformanceData({
      startDate,
      endDate,
      metrics
    });
    
    if (!performanceData.success) {
      throw new Error(`Failed to retrieve niche data: ${performanceData.error}`);
    }
    
    if (performanceData.data.length === 0) {
      logger.warn('No niche performance data available for the specified period');
      return {
        success: false,
        error: 'No data available',
        outputPath
      };
    }
    
    // Define CSV headers based on the first data entry
    const firstRow = performanceData.data[0];
    const headers = Object.keys(firstRow).map(key => ({
      id: key,
      title: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    }));
    
    // Create CSV writer
    const csvWriter = createCsvWriter({
      path: outputPath,
      header: headers
    });
    
    // Write data to CSV
    await csvWriter.writeRecords(performanceData.data);
    logger.info(`Report generated successfully at ${outputPath}`);
    
    return {
      success: true,
      reportPath: outputPath,
      recordCount: performanceData.data.length,
      generatedAt: new Date().toISOString(),
      dateRange: performanceData.dateRange
    };
  } catch (error) {
    logger.error('Report generation failed:', error);
    
    return {
      success: false,
      error: error.message,
      details: error.stack,
      outputPath
    };
  }
}

/**
 * Generate a comparison report between two niches
 * 
 * @param {string} niche1Id - ID of first niche to compare
 * @param {string} niche2Id - ID of second niche to compare
 * @param {Object} options - Report options 
 * @returns {Promise<Object>} - Comparison report data
 */
async function generateNicheComparisonReport(niche1Id, niche2Id, options = {}) {
  const {
    outputDir = './reports',
    filename = `niche-comparison-${new Date().toISOString().split('T')[0]}.csv`,
    timeframe = 'last_90_days'
  } = options;
  
  const outputPath = path.join(outputDir, filename);
  let client;
  
  try {
    // Input validation
    if (!niche1Id || !niche2Id) {
      throw new Error('Both niche IDs are required for comparison');
    }
    
    // Ensure reports directory exists
    await fs.mkdir(outputDir, { recursive: true });
    
    // Connect to database
    client = await pool.connect();
    logger.info(`Connected to database for niche comparison: ${niche1Id} vs ${niche2Id}`);
    
    // Determine date range based on timeframe
    let startDate = new Date();
    const endDate = new Date();
    
    if (timeframe === 'last_30_days') {
      startDate.setDate(startDate.getDate() - 30);
    } else if (timeframe === 'last_90_days') {
      startDate.setDate(startDate.getDate() - 90);
    } else if (timeframe === 'last_6_months') {
      startDate.setMonth(startDate.getMonth() - 6);
    } else if (timeframe === 'last_year') {
      startDate.setFullYear(startDate.getFullYear() - 1);
    }
    
    // First check if both niches exist
    const nicheCheckQuery = `
      SELECT id, name FROM niches WHERE id IN ($1, $2)
    `;
    
    const nicheCheckResult = await client.query(nicheCheckQuery, [niche1Id, niche2Id]);
    
    if (nicheCheckResult.rows.length < 2) {
      throw new Error('One or both of the specified niches do not exist');
    }
    
    // Query for detailed niche comparison with enhanced grouping
    const query = `
      SELECT
        n.id,
        n.name,
        n.competition_score,
        n.monetization_potential,
        n.trending_score,
        n.monthly_search_volume,
        n.estimated_cpc,
        COUNT(DISTINCT s.id) as site_count,
        AVG(s.monthly_traffic) as avg_traffic,
        MAX(s.monthly_traffic) as max_traffic,
        SUM(s.monthly_revenue) as total_revenue,
        AVG(s.monthly_revenue) as avg_revenue,
        MAX(s.monthly_revenue) as max_revenue,
        AVG(s.conversion_rate) as avg_conversion_rate,
        AVG(s.domain_authority) as avg_domain_authority,
        SUM(s.total_backlinks) as total_backlinks,
        AVG(s.organic_keywords) as avg_organic_keywords,
        (
          SELECT AVG(c.seo_score)
          FROM content c
          JOIN sites s2 ON c.site_id = s2.id
          WHERE s2.niche_id = n.id
        ) as avg_content_score,
        (
          SELECT COUNT(*)
          FROM content c
          JOIN sites s2 ON c.site_id = s2.id
          WHERE s2.niche_id = n.id
        ) as total_content_count,
        (
          SELECT STRING_AGG(keyword, ', ' ORDER BY keyword)
          FROM (
            SELECT DISTINCT nk.keyword
            FROM niche_keywords nk
            WHERE nk.niche_id = n.id
            LIMIT 10
          ) as keywords
        ) as top_keywords
      FROM
        niches n
      LEFT JOIN
        sites s ON n.id = s.niche_id
      WHERE
        n.id IN ($1, $2)
        AND (s.created_at BETWEEN $3 AND $4 OR s.created_at IS NULL)
      GROUP BY
        n.id, n.name, n.competition_score, n.monetization_potential, 
        n.trending_score, n.monthly_search_volume, n.estimated_cpc
    `;
    
    const result = await client.query(query, [
      niche1Id,
      niche2Id,
      startDate.toISOString(),
      endDate.toISOString()
    ]);
    
    // Verify we have data for both niches
    if (result.rows.length !== 2) {
      // Check which niche has data
      const foundNiches = result.rows.map(row => row.id);
      const missingNiches = [niche1Id, niche2Id].filter(id => !foundNiches.includes(id));
      
      throw new Error(`Could not retrieve performance data for niche(s): ${missingNiches.join(', ')}`);
    }
    
    // Process comparison data
    const niche1 = result.rows.find(row => row.id === niche1Id);
    const niche2 = result.rows.find(row => row.id === niche2Id);
    
    // Format numeric values
    [niche1, niche2].forEach(niche => {
      Object.keys(niche).forEach(key => {
        if (typeof niche[key] === 'number') {
          if (key.includes('score') || key.includes('rate') || key.includes('revenue') || key.includes('earnings')) {
            niche[key] = parseFloat(niche[key].toFixed(2));
          } else if (key.includes('count') || key.includes('traffic') || key.includes('volume') || key.includes('backlinks')) {
            niche[key] = parseInt(niche[key], 10);
          }
        }
      });
    });
    
    // Generate comparison metrics
    const metrics = [
      { name: 'Niche Name', niche1: niche1.name, niche2: niche2.name },
      { name: 'Monthly Search Volume', niche1: niche1.monthly_search_volume || 0, niche2: niche2.monthly_search_volume || 0,
        difference: (niche1.monthly_search_volume || 0) - (niche2.monthly_search_volume || 0) },
      { name: 'Competition Score', niche1: niche1.competition_score, niche2: niche2.competition_score, 
        difference: (niche1.competition_score - niche2.competition_score).toFixed(2) },
      { name: 'Monetization Potential', niche1: niche1.monetization_potential, niche2: niche2.monetization_potential,
        difference: (niche1.monetization_potential - niche2.monetization_potential).toFixed(2) },
      { name: 'Trending Score', niche1: niche1.trending_score, niche2: niche2.trending_score,
        difference: (niche1.trending_score - niche2.trending_score).toFixed(2) },
      { name: 'Estimated CPC ($)', niche1: niche1.estimated_cpc?.toFixed(2) || '0.00', niche2: niche2.estimated_cpc?.toFixed(2) || '0.00',
        difference: ((niche1.estimated_cpc || 0) - (niche2.estimated_cpc || 0)).toFixed(2) },
      { name: 'Site Count', niche1: niche1.site_count || 0, niche2: niche2.site_count || 0,
        difference: (niche1.site_count || 0) - (niche2.site_count || 0) },
      { name: 'Average Traffic', niche1: Math.round(niche1.avg_traffic || 0), niche2: Math.round(niche2.avg_traffic || 0),
        difference: Math.round((niche1.avg_traffic || 0) - (niche2.avg_traffic || 0)) },
      { name: 'Maximum Traffic', niche1: niche1.max_traffic || 0, niche2: niche2.max_traffic || 0,
        difference: (niche1.max_traffic || 0) - (niche2.max_traffic || 0) },
      { name: 'Total Revenue ($)', niche1: (niche1.total_revenue || 0).toFixed(2), niche2: (niche2.total_revenue || 0).toFixed(2),
        difference: ((niche1.total_revenue || 0) - (niche2.total_revenue || 0)).toFixed(2) },
      { name: 'Average Revenue ($)', niche1: (niche1.avg_revenue || 0).toFixed(2), niche2: (niche2.avg_revenue || 0).toFixed(2),
        difference: ((niche1.avg_revenue || 0) - (niche2.avg_revenue || 0)).toFixed(2) },
      { name: 'Conversion Rate (%)', niche1: (niche1.avg_conversion_rate || 0).toFixed(2), 
        niche2: (niche2.avg_conversion_rate || 0).toFixed(2),
        difference: ((niche1.avg_conversion_rate || 0) - (niche2.avg_conversion_rate || 0)).toFixed(2) },
      { name: 'Average Domain Authority', niche1: (niche1.avg_domain_authority || 0).toFixed(1), 
        niche2: (niche2.avg_domain_authority || 0).toFixed(1),
        difference: ((niche1.avg_domain_authority || 0) - (niche2.avg_domain_authority || 0)).toFixed(1) },
      { name: 'Total Backlinks', niche1: niche1.total_backlinks || 0, niche2: niche2.total_backlinks || 0,
        difference: (niche1.total_backlinks || 0) - (niche2.total_backlinks || 0) },
      { name: 'Average Organic Keywords', niche1: Math.round(niche1.avg_organic_keywords || 0), 
        niche2: Math.round(niche2.avg_organic_keywords || 0),
        difference: Math.round((niche1.avg_organic_keywords || 0) - (niche2.avg_organic_keywords || 0)) },
      { name: 'Average Content Score', niche1: (niche1.avg_content_score || 0).toFixed(1), 
        niche2: (niche2.avg_content_score || 0).toFixed(1),
        difference: ((niche1.avg_content_score || 0) - (niche2.avg_content_score || 0)).toFixed(1) },
      { name: 'Total Content Count', niche1: niche1.total_content_count || 0, niche2: niche2.total_content_count || 0,
        difference: (niche1.total_content_count || 0) - (niche2.total_content_count || 0) }
    ];
    
    // Calculate ROI metrics
    const roi1 = (niche1.avg_revenue || 0) / (niche1.competition_score || 1);
    const roi2 = (niche2.avg_revenue || 0) / (niche2.competition_score || 1);
    
    metrics.push({
      name: 'ROI Score (Revenue/Competition)',
      niche1: roi1.toFixed(2),
      niche2: roi2.toFixed(2),
      difference: (roi1 - roi2).toFixed(2)
    });
    
    // Add keyword comparison
    metrics.push({
      name: 'Top Keywords',
      niche1: niche1.top_keywords || 'N/A',
      niche2: niche2.top_keywords || 'N/A',
      difference: 'N/A'
    });
    
    // Write comparison to CSV
    const csvWriter = createCsvWriter({
      path: outputPath,
      header: [
        { id: 'name', title: 'Metric' },
        { id: 'niche1', title: niche1.name },
        { id: 'niche2', title: niche2.name },
        { id: 'difference', title: 'Difference (Niche1 - Niche2)' }
      ]
    });
    
    await csvWriter.writeRecords(metrics);
    logger.info(`Niche comparison report generated at ${outputPath}`);
    
    return {
      success: true,
      reportPath: outputPath,
      niche1: {
        id: niche1.id,
        name: niche1.name
      },
      niche2: {
        id: niche2.id,
        name: niche2.name
      },
      timeframe,
      generatedAt: new Date().toISOString(),
      metrics: metrics.map(m => ({
        name: m.name,
        difference: m.difference
      }))
    };
  } catch (error) {
    logger.error('Failed to generate niche comparison report:', error);
    
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
  getNichePerformanceData,
  generateReport,
  generateNicheComparisonReport
};
