/**
 * SiteGenie Niche Performance Module
 * Handles retrieval and rendering of niche performance data
 */
const { Pool } = require('pg');
const logger = require('./utils/logger');

// Initialize PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'sitegenie',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

/**
 * Retrieves niche performance data from the database
 * 
 * @param {Object} options - Query options
 * @param {string} [options.industry] - Filter by industry
 * @param {string} [options.investmentLevel] - Filter by investment level (low/medium/high)
 * @param {number} [options.minSearchVolume] - Minimum monthly search volume
 * @param {number} [options.maxCompetition] - Maximum competition score (0-100)
 * @param {string} [options.sortBy='monetization_potential'] - Field to sort by
 * @param {string} [options.sortOrder='DESC'] - Sort order ('ASC' or 'DESC')
 * @param {number} [options.limit=50] - Maximum number of results to return
 * @param {number} [options.offset=0] - Offset for pagination
 * @returns {Promise<Object>} - Niche performance data
 */
async function getNichePerformanceData(options = {}) {
  const {
    industry,
    investmentLevel,
    minSearchVolume = 0,
    maxCompetition = 100,
    sortBy = 'monetization_potential',
    sortOrder = 'DESC',
    limit = 50,
    offset = 0
  } = options;
  
  let client;
  
  try {
    client = await pool.connect();
    logger.info('Connected to database for niche performance data retrieval');
    
    // Build WHERE clause based on filters
    const whereConditions = [];
    const queryParams = [];
    
    // Add params counter to track parameter index
    let paramCounter = 1;
    
    // Filter by monthly search volume
    if (minSearchVolume > 0) {
      whereConditions.push(`monthly_search_volume >= $${paramCounter++}`);
      queryParams.push(minSearchVolume);
    }
    
    // Filter by competition score
    if (maxCompetition < 100) {
      whereConditions.push(`competition_score <= $${paramCounter++}`);
      queryParams.push(maxCompetition);
    }
    
    // Filter by industry if provided
    if (industry) {
      whereConditions.push(`(
        name ILIKE $${paramCounter} OR
        EXISTS (
          SELECT 1 FROM niche_keywords 
          WHERE niche_id = n.id AND keyword ILIKE $${paramCounter}
        )
      )`);
      queryParams.push(`%${industry}%`);
      paramCounter++;
    }
    
    // Filter by investment level
    if (investmentLevel) {
      let investmentCondition;
      
      switch (investmentLevel.toLowerCase()) {
        case 'low':
          investmentCondition = 'competition_score < 30';
          break;
        case 'medium':
          investmentCondition = 'competition_score BETWEEN 30 AND 60';
          break;
        case 'high':
          investmentCondition = 'competition_score > 60';
          break;
        default:
          // No filtering if invalid level
          investmentCondition = null;
      }
      
      if (investmentCondition) {
        whereConditions.push(investmentCondition);
      }
    }
    
    // Combine all WHERE conditions
    const whereClause = whereConditions.length > 0 
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';
    
    // Validate sort parameters to prevent SQL injection
    const validSortColumns = [
      'name', 'monthly_search_volume', 'competition_score', 
      'monetization_potential', 'trending_score', 'estimated_cpc'
    ];
    
    const validSortOrders = ['ASC', 'DESC'];
    
    // Ensure sort parameters are valid
    const sanitizedSortBy = validSortColumns.includes(sortBy) ? sortBy : 'monetization_potential';
    const sanitizedSortOrder = validSortOrders.includes(sortOrder.toUpperCase()) ? sortOrder.toUpperCase() : 'DESC';
    
    // Build full query
    const query = `
      SELECT 
        n.id,
        n.name,
        n.monthly_search_volume,
        n.competition_score,
        n.monetization_potential,
        n.trending_score,
        n.estimated_cpc,
        n.created_at,
        n.last_updated,
        (
          SELECT COUNT(*) 
          FROM sites s 
          WHERE s.niche_id = n.id
        ) AS site_count,
        (
          SELECT json_agg(keyword) 
          FROM (
            SELECT keyword 
            FROM niche_keywords 
            WHERE niche_id = n.id 
            LIMIT 10
          ) AS keywords
        ) AS related_keywords
      FROM 
        niches n
      ${whereClause}
      ORDER BY 
        ${sanitizedSortBy} ${sanitizedSortOrder}
      LIMIT $${paramCounter++}
      OFFSET $${paramCounter++}
    `;
    
    // Add limit and offset to params
    queryParams.push(limit, offset);
    
    // Execute query
    const result = await client.query(query, queryParams);
    logger.info(`Retrieved ${result.rows.length} niche performance records`);
    
    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM niches n
      ${whereClause}
    `;
    
    const countResult = await client.query(countQuery, queryParams.slice(0, -2)); // Remove limit and offset
    const totalCount = parseInt(countResult.rows[0].total, 10);
    
    // Process and format the data
    const formattedData = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      monthly_search_volume: parseInt(row.monthly_search_volume, 10),
      competition_score: parseFloat(row.competition_score.toFixed(2)),
      monetization_potential: parseFloat(row.monetization_potential.toFixed(2)),
      trending_score: parseFloat(row.trending_score.toFixed(2)),
      estimated_cpc: parseFloat(row.estimated_cpc.toFixed(2)),
      created_at: row.created_at.toISOString(),
      last_updated: row.last_updated ? row.last_updated.toISOString() : null,
      site_count: parseInt(row.site_count, 10),
      related_keywords: row.related_keywords || [],
      // Calculate a recommendation score (weighted average)
      recommendation_score: parseFloat((
        (10 - row.competition_score/10) * 0.4 + 
        row.monetization_potential * 0.4 + 
        row.trending_score * 0.2
      ).toFixed(2))
    }));
    
    return {
      success: true,
      data: formattedData,
      pagination: {
        total: totalCount,
        page: Math.floor(offset / limit) + 1,
        pageSize: limit,
        totalPages: Math.ceil(totalCount / limit)
      },
      filters: {
        industry,
        investmentLevel,
        minSearchVolume,
        maxCompetition
      }
    };
  } catch (error) {
    logger.error('Error retrieving niche performance data:', error);
    
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
 * Renders niche performance data as an HTML table
 * 
 * @param {Array<Object>} nicheData - Niche performance data to render
 * @param {Object} options - Rendering options
 * @param {boolean} [options.includeRecommendationScore=true] - Whether to include recommendation score
 * @param {boolean} [options.includeRelatedKeywords=false] - Whether to include related keywords
 * @param {boolean} [options.includePagination=true] - Whether to include pagination controls
 * @param {Object} [options.pagination] - Pagination information
 * @param {string} [options.tableClass='niche-performance-table'] - CSS class for the table
 * @returns {string} - HTML table representation of the data
 */
function renderNichePerformanceTable(nicheData, options = {}) {
  const {
    includeRecommendationScore = true,
    includeRelatedKeywords = false,
    includePagination = true,
    pagination,
    tableClass = 'niche-performance-table'
  } = options;
  
  if (!nicheData || !Array.isArray(nicheData) || nicheData.length === 0) {
    return '<p>No niche performance data available.</p>';
  }
  
  // Define table columns
  const columns = [
    { key: 'name', label: 'Niche' },
    { key: 'monthly_search_volume', label: 'Monthly Searches' },
    { key: 'competition_score', label: 'Competition' },
    { key: 'monetization_potential', label: 'Monetization' },
    { key: 'trending_score', label: 'Trending' },
    { key: 'estimated_cpc', label: 'Est. CPC ($)' }
  ];
  
  // Add recommendation score if requested
  if (includeRecommendationScore) {
    columns.push({ key: 'recommendation_score', label: 'Recommendation' });
  }
  
  // Add site count if available
  if (nicheData[0].site_count !== undefined) {
    columns.push({ key: 'site_count', label: 'Sites' });
  }
  
  // Add related keywords if requested
  if (includeRelatedKeywords) {
    columns.push({ key: 'related_keywords', label: 'Related Keywords' });
  }
  
  // Generate table header
  let html = `<table class="${tableClass}">
  <thead>
    <tr>
      ${columns.map(col => `<th>${col.label}</th>`).join('')}
    </tr>
  </thead>
  <tbody>`;
  
  // Generate table rows
  nicheData.forEach(niche => {
    html += '<tr>';
    
    columns.forEach(column => {
      if (column.key === 'competition_score') {
        // Format competition score with color indicator
        const score = niche[column.key];
        let competitionClass = '';
        
        if (score < 30) competitionClass = 'low-competition';
        else if (score < 60) competitionClass = 'medium-competition';
        else competitionClass = 'high-competition';
        
        html += `<td class="${competitionClass}">${score}</td>`;
      } 
      else if (column.key === 'related_keywords') {
        // Format related keywords as a comma-separated list
        const keywords = Array.isArray(niche[column.key]) ? niche[column.key] : [];
        html += `<td>${keywords.slice(0, 3).join(', ')}</td>`;
      }
      else if (column.key === 'monetization_potential' || column.key === 'trending_score' || column.key === 'recommendation_score') {
        // Format scores out of 10
        const score = niche[column.key];
        let scoreClass = '';
        
        if (score < 4) scoreClass = 'low-score';
        else if (score < 7) scoreClass = 'medium-score';
        else scoreClass = 'high-score';
        
        html += `<td class="${scoreClass}">${score}/10</td>`;
      }
      else {
        // Default formatting
        html += `<td>${niche[column.key]}</td>`;
      }
    });
    
    html += '</tr>';
  });
  
  html += '</tbody></table>';
  
  // Add pagination if requested
  if (includePagination && pagination) {
    const { total, page, pageSize, totalPages } = pagination;
    
    html += `
    <div class="pagination">
      <span>Showing ${pageSize * (page - 1) + 1} to ${Math.min(pageSize * page, total)} of ${total} niches</span>
      <div class="pagination-controls">
    `;
    
    // Previous page link
    if (page > 1) {
      html += `<a href="?page=${page - 1}" class="pagination-link">Previous</a>`;
    } else {
      html += `<span class="pagination-link disabled">Previous</span>`;
    }
    
    // Page numbers
    const startPage = Math.max(1, page - 2);
    const endPage = Math.min(totalPages, page + 2);
    
    for (let i = startPage; i <= endPage; i++) {
      if (i === page) {
        html += `<span class="pagination-link current">${i}</span>`;
      } else {
        html += `<a href="?page=${i}" class="pagination-link">${i}</a>`;
      }
    }
    
    // Next page link
    if (page < totalPages) {
      html += `<a href="?page=${page + 1}" class="pagination-link">Next</a>`;
    } else {
      html += `<span class="pagination-link disabled">Next</span>`;
    }
    
    html += `
      </div>
    </div>
    `;
  }
  
  return html;
}

/**
 * Exports niche performance data to CSV format
 * 
 * @param {Array<Object>} nicheData - Niche performance data to export
 * @param {Object} options - Export options
 * @param {boolean} [options.includeHeader=true] - Whether to include CSV header
 * @param {Array<string>} [options.columns] - Specific columns to include
 * @returns {string} - CSV formatted string
 */
function exportNicheDataToCSV(nicheData, options = {}) {
  const {
    includeHeader = true,
    columns = [
      'name', 'monthly_search_volume', 'competition_score',
      'monetization_potential', 'trending_score', 'estimated_cpc',
      'recommendation_score', 'site_count'
    ]
  } = options;
  
  if (!nicheData || !Array.isArray(nicheData) || nicheData.length === 0) {
    return '';
  }
  
  // Define column headers mapping
  const columnHeaders = {
    name: 'Niche',
    monthly_search_volume: 'Monthly Searches',
    competition_score: 'Competition Score',
    monetization_potential: 'Monetization Potential',
    trending_score: 'Trending Score',
    estimated_cpc: 'Estimated CPC ($)',
    recommendation_score: 'Recommendation Score',
    site_count: 'Number of Sites',
    related_keywords: 'Related Keywords',
    created_at: 'Created At',
    last_updated: 'Last Updated'
  };
  
  // Validate requested columns exist in data
  const validColumns = columns.filter(col => 
    col in nicheData[0] || (col === 'recommendation_score' && 'monetization_potential' in nicheData[0])
  );
  
  // Prepare CSV header row
  let csv = '';
  if (includeHeader) {
    csv += validColumns.map(col => `"${columnHeaders[col] || col}"`).join(',') + '\n';
  }
  
  // Add data rows
  nicheData.forEach(niche => {
    const row = validColumns.map(col => {
      let value = niche[col];
      
      // Handle special case for recommendation score if not directly in data
      if (col === 'recommendation_score' && value === undefined) {
        value = parseFloat((
          (10 - niche.competition_score/10) * 0.4 + 
          niche.monetization_potential * 0.4 + 
          niche.trending_score * 0.2
        ).toFixed(2));
      }
      
      // Handle related keywords array
      if (col === 'related_keywords' && Array.isArray(value)) {
        value = value.join(', ');
      }
      
      // Format value for CSV
      if (typeof value === 'string') {
        // Escape quotes and wrap in quotes
        return `"${value.replace(/"/g, '""')}"`;
      } 
      
      return value !== undefined && value !== null ? value : '';
    }).join(',');
    
    csv += row + '\n';
  });
  
  return csv;
}

module.exports = {
  getNichePerformanceData,
  renderNichePerformanceTable,
  exportNicheDataToCSV
};
