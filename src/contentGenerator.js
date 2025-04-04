const axios = require('axios');
const { Pool } = require('pg');
const logger = require('./utils/logger');
const { addToQueue } = require('./utils/queue');
const crypto = require('crypto');
const Chart = require('chart.js');

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
 * Retrieves site data from the database
 * 
 * @param {string} siteId - The ID of the site
 * @returns {Promise<Object|null>} - Site data or null if not found/invalid
 */
async function getSiteData(siteId) {
  let client;
  
  try {
    client = await pool.connect();
    
    const query = `
      SELECT 
        s.id, 
        s.domain_name, 
        s.niche_id,
        s.status,
        n.name as niche_name,
        n.primary_keyword,
        n.competition_score,
        n.trending_score,
        n.target_audience
      FROM sites s
      JOIN niches n ON s.niche_id = n.id
      WHERE s.id = $1
    `;
    
    const result = await client.query(query, [siteId]);
    
    if (result.rows.length === 0) {
      logger.warn(`Site with ID ${siteId} not found`);
      return null;
    }
    
    const siteData = result.rows[0];
    
    // Validate site status
    if (siteData.status !== 'active') {
      logger.warn(`Site ${siteId} is not active (current status: ${siteData.status})`);
      return null;
    }
    
    // Validate niche data
    if (!siteData.niche_id) {
      logger.warn(`Site ${siteId} has no associated niche`);
      return null;
    }
    
    logger.info(`Retrieved data for site ${siteId} (${siteData.domain_name})`);
    return siteData;
    
  } catch (error) {
    logger.error(`Failed to retrieve site data for ${siteId}:`, error);
    return null;
  } finally {
    if (client) {
      client.release();
    }
  }
}

/**
 * Generates content using OpenAI GPT-4 based on the provided content brief
 * 
 * @param {Object} contentBrief - The brief containing details for content generation
 * @param {string} contentBrief.siteId - The ID of the site for which content is being generated
 * @param {string} contentBrief.topic - The main topic of the content
 * @param {string} contentBrief.primaryKeyword - The primary SEO keyword to target
 * @param {number} contentBrief.wordCount - Approximate word count for the content
 * @param {Array} contentBrief.sections - Array of section names to include
 * @param {string} contentBrief.targetAudience - Description of the target audience
 * @param {Array} [contentBrief.secondaryKeywords] - Secondary keywords to include
 * @param {string} [contentBrief.contentType] - Type of content (blog, review, etc.)
 * @param {string} [contentBrief.tone] - Desired tone of the content
 * @returns {Promise<Object>} - Object containing the generated content and metadata
 */
async function generateContent(contentBrief) {
  try {
    // If siteId is provided, fetch site data
    let siteData = null;
    let niche = contentBrief.niche;
    let targetAudience = contentBrief.targetAudience;
    
    if (contentBrief.siteId) {
      siteData = await getSiteData(contentBrief.siteId);
      
      if (!siteData) {
        return {
          status: 'failed',
          message: `Could not retrieve data for site ${contentBrief.siteId}`
        };
      }
      
      // Use site data to enhance the content brief
      niche = siteData.niche_name || niche;
      targetAudience = siteData.target_audience || targetAudience;
    }
    
    const systemPrompt = `You are an expert content writer specializing in ${niche}. 
    Create SEO-optimized content that is informative, engaging, and follows E-E-A-T principles.`;
    
    const userPrompt = `Write a comprehensive article about "${contentBrief.topic}" targeting the keyword "${contentBrief.primaryKeyword}".
    The article should be approximately ${contentBrief.wordCount} words.
    Include the following sections: ${contentBrief.sections.join(', ')}.
    Target audience: ${targetAudience}.
    Include factual information, statistics, and expert insights where possible.`;
    
    // Add secondary keywords if provided
    if (contentBrief.secondaryKeywords && contentBrief.secondaryKeywords.length > 0) {
      userPrompt += `\nPlease naturally incorporate these secondary keywords: ${contentBrief.secondaryKeywords.join(', ')}.`;
    }
    
    // Add tone specification if provided
    if (contentBrief.tone) {
      userPrompt += `\nThe tone of the article should be ${contentBrief.tone}.`;
    }
    
    // Add site context if available
    if (siteData) {
      userPrompt += `\nThis content will be published on ${siteData.domain_name}, a website focused on ${siteData.niche_name}.`;
    }
    
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: Math.min(contentBrief.wordCount * 1.5, 8000), // Ensure it doesn't exceed API limits
      top_p: 1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    return {
      content: response.data.choices[0].message.content,
      tokens_used: response.data.usage.total_tokens,
      completion_time: Date.now(),
      status: 'success',
      site_id: contentBrief.siteId,
      site_domain: siteData?.domain_name
    };
  } catch (error) {
    logger.error('Content generation failed:', error);
    
    if (error.response) {
      const status = error.response.status;
      
      // Handle rate limiting
      if (status === 429) {
        logger.warn('Rate limit reached, queueing content generation');
        
        // Queue for retry with exponential backoff
        await addToQueue('content-generation', contentBrief, { 
          delay: 60000, // 1 minute delay
          priority: 'high'
        });
        
        return { 
          status: 'queued', 
          message: 'Rate limit reached, content generation queued for retry' 
        };
      }
      
      // Handle other API errors
      if (status >= 400 && status < 500) {
        logger.error(`API Error: ${error.response.data.error.message}`);
      } else if (status >= 500) {
        logger.error('OpenAI service error, falling back to alternative model');
        return generateFallbackContent(contentBrief);
      }
    } else if (error.request) {
      logger.error('Network error, request made but no response received');
    } else {
      logger.error('Error setting up request:', error.message);
    }
    
    // Fall back to GPT-3.5 if any other error occurs
    return generateFallbackContent(contentBrief);
  }
}

/**
 * Fallback function that uses GPT-3.5-turbo when GPT-4 fails
 * 
 * @param {Object} contentBrief - The content brief
 * @returns {Promise<Object>} - Object containing the generated content and metadata
 */
async function generateFallbackContent(contentBrief) {
  try {
    logger.info('Attempting fallback content generation with GPT-3.5-turbo');
    
    // If siteId is provided, fetch site data
    let siteData = null;
    let niche = contentBrief.niche;
    let targetAudience = contentBrief.targetAudience;
    
    if (contentBrief.siteId) {
      siteData = await getSiteData(contentBrief.siteId);
      
      if (siteData) {
        niche = siteData.niche_name || niche;
        targetAudience = siteData.target_audience || targetAudience;
      }
    }
    
    const systemPrompt = `You are an expert content writer specializing in ${niche}. 
    Create SEO-optimized content that is informative and engaging.`;
    
    const userPrompt = `Write a comprehensive article about "${contentBrief.topic}" targeting the keyword "${contentBrief.primaryKeyword}".
    The article should be approximately ${contentBrief.wordCount} words.
    Include the following sections: ${contentBrief.sections.join(', ')}.
    Target audience: ${targetAudience}.`;
    
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: Math.min(contentBrief.wordCount * 1.5, 4000), // GPT-3.5 has a smaller token limit
      top_p: 1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    return {
      content: response.data.choices[0].message.content,
      tokens_used: response.data.usage.total_tokens,
      completion_time: Date.now(),
      status: 'success',
      model_used: 'gpt-3.5-turbo', // Indicate fallback model was used
      is_fallback: true,
      site_id: contentBrief.siteId,
      site_domain: siteData?.domain_name
    };
  } catch (error) {
    logger.error('Fallback content generation failed:', error);
    
    // Both primary and fallback methods failed
    return {
      status: 'failed',
      message: 'Content generation failed, both primary and fallback methods unsuccessful',
      error: error.message
    };
  }
}

/**
 * Checks if content is plagiarized using the Copyscape API
 * 
 * @param {string} content - The content to check for plagiarism
 * @returns {Promise<Object>} - Results of the plagiarism check
 */
async function checkPlagiarism(content) {
  try {
    logger.info('Checking content for plagiarism via Copyscape API');
    
    // Copyscape API credentials from environment variables
    const username = process.env.COPYSCAPE_USERNAME;
    const apiKey = process.env.COPYSCAPE_API_KEY;
    
    if (!username || !apiKey) {
      logger.warn('Copyscape API credentials not configured, skipping plagiarism check');
      return {
        isPlagiarized: false,
        similarityScore: 0,
        status: 'skipped',
        message: 'Plagiarism check skipped due to missing API credentials'
      };
    }
    
    // Prepare params for Copyscape API
    const params = new URLSearchParams();
    params.append('u', username);
    params.append('k', apiKey);
    params.append('o', 'csearch'); // Content search operation
    params.append('e', 'UTF-8'); // Encoding
    params.append('t', content);
    params.append('f', 'json'); // Response format
    
    const response = await axios.post('https://www.copyscape.com/api/', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    if (response.data.error) {
      throw new Error(`Copyscape API error: ${response.data.error}`);
    }
    
    // Process results
    const results = response.data.result || [];
    const totalMatches = results.length;
    
    // Calculate highest match percentage
    let highestMatchPercentage = 0;
    let matchedWords = 0;
    let totalWords = content.split(/\s+/).length;
    
    for (const result of results) {
      const wordsMatched = parseInt(result.wordsmatched, 10) || 0;
      if (wordsMatched > matchedWords) {
        matchedWords = wordsMatched;
      }
    }
    
    if (totalWords > 0 && matchedWords > 0) {
      highestMatchPercentage = (matchedWords / totalWords) * 100;
    }
    
    // Consider content plagiarized if similarity is >= 5%
    const isPlagiarized = highestMatchPercentage >= 5;
    
    logger.info(`Plagiarism check complete. Match percentage: ${highestMatchPercentage.toFixed(2)}%. Matches found: ${totalMatches}`);
    
    return {
      isPlagiarized,
      similarityScore: parseFloat(highestMatchPercentage.toFixed(2)),
      matchedWords,
      totalWords,
      totalMatches,
      status: 'completed',
      sources: results.map(r => ({
        url: r.url,
        title: r.title,
        matchedWords: parseInt(r.wordsmatched, 10) || 0,
        snippet: r.textsnippet
      }))
    };
  } catch (error) {
    logger.error('Plagiarism check failed:', error);
    
    return {
      isPlagiarized: false, // Assume not plagiarized when check fails
      status: 'error',
      message: `Plagiarism check failed: ${error.message}`,
      error: error.message
    };
  }
}

/**
 * Checks the generated content for quality and performs post-processing
 * 
 * @param {string} content - The raw generated content
 * @param {Object} contentBrief - The original content brief
 * @returns {Object} - Object containing the processed content and quality metrics
 */
function processContent(content, contentBrief) {
  // Implement content quality checks here
  // - Check for minimum word count
  // - Verify keyword inclusion and density
  // - Add internal links if needed
  // - Format headings and structure
  
  // Simple implementation for now
  const wordCount = content.split(/\s+/).length;
  const keywordDensity = (content.match(new RegExp(contentBrief.primaryKeyword, 'gi')) || []).length / wordCount * 100;
  
  const processedContent = {
    content,
    metrics: {
      wordCount,
      keywordDensity: parseFloat(keywordDensity.toFixed(2)),
      meetsMinimumLength: wordCount >= contentBrief.wordCount * 0.9,
      includesPrimaryKeyword: keywordDensity > 0
    }
  };
  
  // Add a warning if metrics are concerning
  if (!processedContent.metrics.meetsMinimumLength) {
    processedContent.warnings = processedContent.warnings || [];
    processedContent.warnings.push('Content length below target');
  }
  
  if (keywordDensity < 0.5 || keywordDensity > 3) {
    processedContent.warnings = processedContent.warnings || [];
    processedContent.warnings.push('Keyword density outside optimal range (0.5% - 3%)');
  }
  
  return processedContent;
}

/**
 * Saves generated content to the database
 * 
 * @param {Object} contentData - Content data to save
 * @param {string} contentData.siteId - The site ID
 * @param {string} contentData.title - Content title
 * @param {string} contentData.content - The generated content
 * @param {string} contentData.primaryKeyword - Primary keyword
 * @param {string} contentData.contentType - Type of content
 * @returns {Promise<Object>} - Result of the save operation
 */
async function saveContentToDatabase(contentData) {
  let client;
  
  try {
    client = await pool.connect();
    
    // Generate a slug from the title
    const slug = contentData.title
      .toLowerCase()
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
      .trim();
    
    // Check if the slug already exists for this site
    const checkQuery = `
      SELECT id FROM content
      WHERE site_id = $1 AND slug = $2
    `;
    
    const checkResult = await client.query(checkQuery, [
      contentData.siteId,
      slug
    ]);
    
    // If the slug exists, modify it to make it unique
    let finalSlug = slug;
    if (checkResult.rows.length > 0) {
      finalSlug = `${slug}-${Date.now().toString().slice(-6)}`;
    }
    
    // Insert the content
    const insertQuery = `
      INSERT INTO content (
        site_id,
        title,
        slug,
        content,
        content_type,
        status,
        primary_keyword,
        word_count,
        created_at,
        seo_score
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `;
    
    const now = new Date();
    const wordCount = contentData.content.split(/\s+/).length;
    
    const insertResult = await client.query(insertQuery, [
      contentData.siteId,
      contentData.title,
      finalSlug,
      contentData.content,
      contentData.contentType || 'blog_post',
      'draft', // Default status
      contentData.primaryKeyword,
      wordCount,
      now.toISOString(),
      contentData.seoScore || 70 // Default SEO score
    ]);
    
    const contentId = insertResult.rows[0].id;
    
    logger.info(`Content saved to database with ID: ${contentId}`);
    
    return {
      success: true,
      contentId,
      slug: finalSlug,
      wordCount,
      createdAt: now.toISOString()
    };
    
  } catch (error) {
    logger.error('Failed to save content to database:', error);
    
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
 * Renders site performance data as a bar graph using Chart.js
 * 
 * @param {string} siteId - The ID of the site
 * @param {string} canvasId - The ID of the HTML canvas element to render the graph
 * @param {Object} options - Rendering options
 * @param {string} [options.period='last_30_days'] - Time period for data (last_30_days, last_90_days, last_year)
 * @param {Array<string>} [options.metrics] - Specific metrics to display
 * @param {string} [options.graphType='bar'] - Type of graph to render (bar, line)
 * @returns {Promise<Object>} - Result of the graph rendering operation
 */
async function renderSitePerformanceGraph(siteId, canvasId, options = {}) {
  try {
    // Default options
    const {
      period = 'last_30_days',
      metrics = ['pageviews', 'sessions', 'conversion_rate', 'avg_session_duration'],
      graphType = 'bar'
    } = options;
    
    // Validate required parameters
    if (!siteId) {
      throw new Error('Site ID is required');
    }
    
    if (!canvasId) {
      throw new Error('Canvas ID is required');
    }
    
    // Get the canvas element
    const canvas = document.getElementById(canvasId);
    if (!canvas) {
      throw new Error(`Canvas element with ID "${canvasId}" not found`);
    }
    
    // Determine date range based on period
    let startDate = new Date();
    const endDate = new Date();
    
    switch (period) {
      case 'last_7_days':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'last_30_days':
        startDate.setDate(startDate.getDate() - 30);
        break;
      case 'last_90_days':
        startDate.setDate(startDate.getDate() - 90);
        break;
      case 'last_year':
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        startDate.setDate(startDate.getDate() - 30); // Default to 30 days
    }
    
    logger.info(`Retrieving performance data for site ${siteId} from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    // Fetch performance data from API
    const response = await axios.get(`/api/sites/${siteId}/performance`, {
      params: {
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        metrics: metrics.join(',')
      }
    });
    
    const performanceData = response.data;
    
    if (!performanceData || !performanceData.success) {
      throw new Error('Failed to retrieve performance data');
    }
    
    if (!performanceData.data || performanceData.data.length === 0) {
      logger.warn(`No performance data available for site ${siteId}`);
      return {
        success: false,
        message: 'No performance data available for the selected period'
      };
    }
    
    // Process data for Chart.js
    const timeLabels = [];
    const datasets = {};
    
    // Initialize datasets for each metric
    metrics.forEach(metric => {
      datasets[metric] = {
        label: formatMetricLabel(metric),
        data: [],
        backgroundColor: getColorForMetric(metric),
        borderColor: getColorForMetric(metric),
        borderWidth: 1
      };
    });
    
    // Populate datasets with performance data
    performanceData.data.forEach(dataPoint => {
      // Format date for display
      const date = new Date(dataPoint.date);
      let dateLabel;
      
      if (period === 'last_7_days' || period === 'last_30_days') {
        dateLabel = date.toLocaleDateString();
      } else {
        dateLabel = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      }
      
      timeLabels.push(dateLabel);
      
      // Add data for each metric
      metrics.forEach(metric => {
        datasets[metric].data.push(dataPoint[metric] || 0);
      });
    });
    
    // Create chart configuration
    const chartConfig = {
      type: graphType,
      data: {
        labels: timeLabels,
        datasets: Object.values(datasets)
      },
      options: {
        responsive: true,
        plugins: {
          legend: {
            position: 'top',
          },
          title: {
            display: true,
            text: `Site Performance - ${formatPeriodLabel(period)}`
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }
                if (context.parsed.y !== null) {
                  if (context.dataset.label.includes('Rate')) {
                    label += context.parsed.y.toFixed(2) + '%';
                  } else if (context.dataset.label.includes('Duration')) {
                    label += formatDuration(context.parsed.y);
                  } else {
                    label += context.parsed.y.toLocaleString();
                  }
                }
                return label;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                // Format y-axis values based on metric type
                if (this.chart.data.datasets[0].label.includes('Rate')) {
                  return value + '%';
                } else if (this.chart.data.datasets[0].label.includes('Duration')) {
                  return formatDuration(value);
                } else {
                  return value.toLocaleString();
                }
              }
            }
          }
        }
      }
    };
    
    // Create the chart
    new Chart(canvas, chartConfig);
    
    logger.info(`Performance graph rendered successfully for site ${siteId}`);
    
    return {
      success: true,
      metrics: metrics,
      period: period,
      dataPoints: performanceData.data.length
    };
  } catch (error) {
    logger.error(`Failed to render performance graph for site ${siteId}:`, error);
    
    // Check if it's a canvas-related error
    if (error.message.includes('Canvas')) {
      return {
        success: false,
        error: error.message,
        type: 'dom_error'
      };
    }
    
    // Check if it's a data retrieval error
    if (error.message.includes('performance data')) {
      return {
        success: false,
        error: error.message,
        type: 'data_error'
      };
    }
    
    return {
      success: false,
      error: error.message,
      details: error.stack
    };
  }
}

/**
 * Helper function to format metric labels for display
 * 
 * @param {string} metric - The metric name
 * @returns {string} - Formatted label
 */
function formatMetricLabel(metric) {
  const labels = {
    pageviews: 'Page Views',
    sessions: 'Sessions',
    users: 'Users',
    conversion_rate: 'Conversion Rate',
    bounce_rate: 'Bounce Rate',
    avg_session_duration: 'Avg. Session Duration',
    revenue: 'Revenue',
    transactions: 'Transactions'
  };
  
  return labels[metric] || metric.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Helper function to get a color for a specific metric
 * 
 * @param {string} metric - The metric name
 * @returns {string} - Color in hex or rgba format
 */
function getColorForMetric(metric) {
  const colors = {
    pageviews: 'rgba(54, 162, 235, 0.7)',
    sessions: 'rgba(75, 192, 192, 0.7)',
    users: 'rgba(153, 102, 255, 0.7)',
    conversion_rate: 'rgba(255, 159, 64, 0.7)',
    bounce_rate: 'rgba(255, 99, 132, 0.7)',
    avg_session_duration: 'rgba(255, 205, 86, 0.7)',
    revenue: 'rgba(46, 204, 113, 0.7)',
    transactions: 'rgba(52, 152, 219, 0.7)'
  };
  
  return colors[metric] || `hsl(${Math.floor(Math.random() * 360)}, 70%, 60%)`;
}

/**
 * Helper function to format the time period label
 * 
 * @param {string} period - The time period
 * @returns {string} - Formatted label
 */
function formatPeriodLabel(period) {
  const labels = {
    last_7_days: 'Last 7 Days',
    last_30_days: 'Last 30 Days',
    last_90_days: 'Last 90 Days',
    last_year: 'Last Year'
  };
  
  return labels[period] || period.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Helper function to format duration in seconds to a readable format
 * 
 * @param {number} seconds - Duration in seconds
 * @returns {string} - Formatted duration
 */
function formatDuration(seconds) {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  } else {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}m ${remainingSeconds}s`;
  }
}

/**
 * Main function to generate and process content based on a brief
 * 
 * @param {Object} contentBrief - The content brief
 * @param {boolean} [skipPlagiarismCheck=false] - Whether to skip the plagiarism check
 * @param {boolean} [saveToDatabase=false] - Whether to save the content to the database
 * @returns {Promise<Object>} - The final processed content
 */
async function createContent(contentBrief, skipPlagiarismCheck = false, saveToDatabase = false) {
  try {
    // Validate that we have the required brief information
    if (!contentBrief.topic || !contentBrief.primaryKeyword) {
      return {
        status: 'failed',
        message: 'Content brief must include topic and primaryKeyword'
      };
    }
    
    // Ensure basic defaults are set
    contentBrief.wordCount = contentBrief.wordCount || 1500;
    contentBrief.sections = contentBrief.sections || ['Introduction', 'Main Content', 'Conclusion'];
    
    // Step 1: Generate the content
    const generationResult = await generateContent(contentBrief);
    
    if (generationResult.status !== 'success') {
      return generationResult; // Return early if content generation failed
    }
    
    // Step 2: Process the content for quality metrics
    const processedResult = processContent(generationResult.content, contentBrief);
    
    // Step 3: Check for plagiarism (unless skipped)
    if (!skipPlagiarismCheck) {
      const plagiarismResult = await checkPlagiarism(processedResult.content);
      
      // If plagiarized content is detected
      if (plagiarismResult.isPlagiarized) {
        logger.warn(`Plagiarized content detected. Similarity score: ${plagiarismResult.similarityScore}%`);
        
        // Option 1: Return error and reject the content
        return {
          status: 'failed',
          message: 'Content generation failed due to plagiarism detection',
          plagiarismDetails: plagiarismResult,
          originalContent: processedResult.content // Include original for reference/debugging
        };
        
        // Option 2 (alternative): Regenerate content with stricter originality prompt
        // This could be implemented as an alternative approach
        // return regenerateWithOriginality(contentBrief, plagiarismResult);
      }
      
      // Add plagiarism check results to the response
      processedResult.plagiarismCheck = plagiarismResult;
    }
    
    // Step 4: Save to database if requested
    let saveResult = null;
    if (saveToDatabase && contentBrief.siteId) {
      saveResult = await saveContentToDatabase({
        siteId: contentBrief.siteId,
        title: contentBrief.title || contentBrief.topic,
        content: processedResult.content,
        primaryKeyword: contentBrief.primaryKeyword,
        contentType: contentBrief.contentType || 'blog_post',
        seoScore: calculateSEOScore(processedResult)
      });
      
      if (!saveResult.success) {
        logger.error('Failed to save content to database');
      }
    }
    
    // Return the final result
    return {
      ...generationResult,
      ...processedResult,
      ...(saveResult && { databaseSave: saveResult }),
      status: 'success'
    };
  } catch (error) {
    logger.error('Error in createContent:', error);
    
    return {
      status: 'failed',
      message: `An unexpected error occurred: ${error.message}`,
      error: error.stack
    };
  }
}

/**
 * Calculates an SEO score for the content based on various metrics
 * 
 * @param {Object} processedContent - The processed content result
 * @returns {number} - SEO score between 0-100
 */
function calculateSEOScore(processedContent) {
  let score = 70; // Base score
  const metrics = processedContent.metrics;
  
  // Word count scoring
  if (metrics.wordCount >= metrics.targetWordCount * 1.1) {
    score += 10; // Exceeds target by 10%+
  } else if (metrics.wordCount >= metrics.targetWordCount) {
    score += 5; // Meets target
  } else if (metrics.wordCount < metrics.targetWordCount * 0.8) {
    score -= 10; // Significantly below target
  } else if (metrics.wordCount < metrics.targetWordCount) {
    score -= 5; // Below target
  }
  
  // Keyword density scoring
  if (metrics.keywordDensity >= 0.5 && metrics.keywordDensity <= 2.5) {
    score += 10; // Optimal range
  } else if (metrics.keywordDensity > 2.5 && metrics.keywordDensity <= 3.5) {
    score += 5; // Acceptable but high
  } else if (metrics.keywordDensity > 3.5) {
    score -= 10; // Keyword stuffing
  } else if (metrics.keywordDensity < 0.5) {
    score -= 5; // Too low
  }
  
  // Apply penalties for warnings
  if (processedContent.warnings && processedContent.warnings.length > 0) {
    score -= (processedContent.warnings.length * 5);
  }
  
  // Ensure score stays within 0-100 range
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Regenerates content with enhanced originality instructions
 * This is an alternative approach when plagiarism is detected
 * 
 * @param {Object} contentBrief - The content brief
 * @param {Object} plagiarismResult - Results from the plagiarism check
 * @returns {Promise<Object>} - The regenerated content
 */
async function regenerateWithOriginality(contentBrief, plagiarismResult) {
  logger.info('Regenerating content with enhanced originality instructions');
  
  // Create a modified brief with stronger originality instructions
  const enhancedBrief = {
    ...contentBrief,
    forceOriginality: true
  };
  
  if (plagiarismResult.sources && plagiarismResult.sources.length > 0) {
    // Add information about detected sources to avoid
    enhancedBrief.avoidSimilarityTo = plagiarismResult.sources.map(source => 
      `"${source.title}" (${source.url})`
    ).join(', ');
  }
  
  // Generate new content with enhanced brief
  const regeneratedResult = await generateContent(enhancedBrief);
  
  if (regeneratedResult.status === 'success') {
    // Process the regenerated content
    const processedResult = processContent(regeneratedResult.content, contentBrief);
    
    // Check plagiarism again
    const secondPlagiarismCheck = await checkPlagiarism(processedResult.content);
    
    if (secondPlagiarismCheck.isPlagiarized) {
      // If still plagiarized, give up and return error
      logger.error('Regenerated content still contains plagiarism');
      return {
        status: 'failed',
        message: 'Unable to generate original content after multiple attempts',
        plagiarismDetails: secondPlagiarismCheck
      };
    }
    
    // Return successful regeneration
    return {
      ...regeneratedResult,
      ...processedResult,
      plagiarismCheck: secondPlagiarismCheck,
      wasRegenerated: true
    };
  }
  
  // If regeneration failed
  return regeneratedResult;
}

module.exports = {
  generateContent,
  createContent,
  processContent,
  checkPlagiarism,
  regenerateWithOriginality,
  getSiteData,
  saveContentToDatabase,
  renderSitePerformanceGraph
};
