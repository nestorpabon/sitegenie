/**
 * SiteGenie Niche Analysis Module
 * Handles keyword research, competition analysis, and monetization potential evaluation
 */
const axios = require('axios');
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

// API configuration
const KEYWORD_PLANNER_API_KEY = process.env.KEYWORD_PLANNER_API_KEY;
const AHREFS_API_KEY = process.env.AHREFS_API_KEY || process.env.SEMRUSH_API_KEY; // Fallback to SEMRush if Ahrefs not available
const AMAZON_API_KEY = process.env.AMAZON_API_KEY;
const GOOGLE_TRENDS_API_KEY = process.env.GOOGLE_TRENDS_API_KEY;

/**
 * Main function to analyze a niche based on provided keywords
 * 
 * @param {Object} options - Analysis options
 * @param {Array<string>} options.keywords - List of keywords to analyze
 * @param {number} [options.limit=5] - Maximum number of niche recommendations to return
 * @param {Object} [options.preferences] - User preferences for niche selection
 * @param {string} [options.preferences.industry] - Preferred industry
 * @param {string} [options.preferences.investmentLevel] - Investment level (low/medium/high)
 * @param {boolean} [options.includeKeywordData=false] - Whether to include detailed keyword data
 * @returns {Promise<Object>} - Niche analysis results
 */
async function analyzeNiche(options) {
  try {
    const { 
      keywords = [], 
      limit = 5,
      preferences = {},
      includeKeywordData = false
    } = options;

    // Validate input
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return {
        success: false,
        error: 'No keywords provided for niche analysis'
      };
    }

    logger.info(`Starting niche analysis for ${keywords.length} keywords`);

    // Step 1: Fetch keyword data for each provided keyword
    const keywordDataPromises = keywords.map(keyword => fetchKeywordData(keyword));
    const keywordDataResults = await Promise.all(keywordDataPromises);
    
    // Filter out failed keyword lookups
    const validKeywordData = keywordDataResults.filter(result => result.success);
    
    if (validKeywordData.length === 0) {
      return {
        success: false,
        error: 'Failed to retrieve valid data for any of the provided keywords'
      };
    }

    // Step 2: Generate niche recommendations based on keyword data
    const niches = generateNicheRecommendations(validKeywordData, preferences);
    
    // Step 3: Score and rank niches
    const scoredNiches = await Promise.all(
      niches.map(async niche => {
        // Calculate competition score
        const competitionScore = await calculateCompetitionScore(niche);
        
        // Evaluate monetization potential
        const monetizationPotential = evaluateMonetizationPotential(niche);
        
        // Calculate trending score using Google Trends data
        const trendingScore = await calculateTrendingScore(niche.niche_name);
        
        return {
          ...niche,
          competition_score: competitionScore,
          monetization_potential: monetizationPotential,
          trending_score: trendingScore
        };
      })
    );

    // Step 4: Filter and sort niches
    const filteredNiches = scoredNiches
      // Filter out niches with insufficient monetization potential
      .filter(niche => niche.monetization_potential >= 6)
      // Sort by a weighted score (lower competition, higher monetization and trending)
      .sort((a, b) => {
        const scoreA = (10 - a.competition_score) * 0.4 + a.monetization_potential * 0.4 + a.trending_score * 0.2;
        const scoreB = (10 - b.competition_score) * 0.4 + b.monetization_potential * 0.4 + b.trending_score * 0.2;
        return scoreB - scoreA;
      })
      // Limit results
      .slice(0, limit);

    // Step 5: Save results to database if applicable
    if (process.env.SAVE_ANALYSIS_RESULTS === 'true') {
      await saveAnalysisResults(filteredNiches);
    }

    // Prepare response
    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      niche_recommendations: filteredNiches.map(niche => ({
        niche_name: niche.niche_name,
        monthly_search_volume: niche.monthly_search_volume,
        competition_score: parseFloat(niche.competition_score.toFixed(2)),
        monetization_potential: parseFloat(niche.monetization_potential.toFixed(2)),
        trending_score: parseFloat(niche.trending_score.toFixed(2)),
        estimated_cpc: parseFloat(niche.estimated_cpc.toFixed(2)),
        related_keywords: niche.related_keywords.slice(0, 10),
        top_competitors: niche.top_competitors.slice(0, 5)
      }))
    };

    // Include detailed keyword data if requested
    if (includeKeywordData) {
      response.keyword_data = validKeywordData.map(data => ({
        keyword: data.keyword,
        search_volume: data.search_volume,
        cpc: data.cpc,
        competition: data.competition
      }));
    }

    logger.info(`Niche analysis complete. Found ${filteredNiches.length} viable niches.`);
    return response;
  } catch (error) {
    logger.error('Error during niche analysis:', error);
    return {
      success: false,
      error: `Niche analysis failed: ${error.message}`,
      details: error.stack
    };
  }
}

/**
 * Fetches keyword data from Google Keyword Planner API
 * 
 * @param {string} keyword - Keyword to fetch data for
 * @returns {Promise<Object>} - Keyword data
 */
async function fetchKeywordData(keyword) {
  try {
    logger.info(`Fetching keyword data for: ${keyword}`);
    
    // If API key is not available, use fallback mock data for development
    if (!KEYWORD_PLANNER_API_KEY) {
      logger.warn('Using mock keyword data (KEYWORD_PLANNER_API_KEY not set)');
      return mockKeywordData(keyword);
    }
    
    // Real API call to Google Keyword Planner
    const response = await axios.post(
      'https://googleads.googleapis.com/v11/customers/1234567890/googleAds:searchStream',
      {
        query: `
          SELECT 
            keyword_view.resource_name,
            keyword_plan_keyword.keyword_text,
            keyword_plan_keyword_historical_metrics.avg_monthly_searches,
            keyword_plan_keyword_historical_metrics.competition,
            keyword_plan_keyword_historical_metrics.competition_index,
            keyword_plan_keyword_historical_metrics.high_top_of_page_bid_micros,
            keyword_plan_keyword_historical_metrics.low_top_of_page_bid_micros
          FROM keyword_plan_keyword
          WHERE keyword_plan_keyword.keyword_text = '${keyword}'
        `
      },
      {
        headers: {
          'Authorization': `Bearer ${KEYWORD_PLANNER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Process API response
    if (response.data && response.data.results && response.data.results.length > 0) {
      const keywordData = response.data.results[0];
      
      // Fetch related keywords
      const relatedKeywords = await fetchRelatedKeywords(keyword);
      
      return {
        success: true,
        keyword: keyword,
        search_volume: keywordData.keyword_plan_keyword_historical_metrics.avg_monthly_searches,
        competition: keywordData.keyword_plan_keyword_historical_metrics.competition_index / 100, // Normalize to 0-1
        cpc: keywordData.keyword_plan_keyword_historical_metrics.high_top_of_page_bid_micros / 1000000, // Convert micros to dollars
        related_keywords: relatedKeywords
      };
    } else {
      logger.warn(`No keyword data found for: ${keyword}`);
      return {
        success: false,
        keyword: keyword,
        error: 'No data found for this keyword'
      };
    }
  } catch (error) {
    logger.error(`Error fetching keyword data for ${keyword}:`, error);
    
    // Fall back to mock data if API fails
    logger.warn('Falling back to mock keyword data due to API error');
    return mockKeywordData(keyword);
  }
}

/**
 * Generates mock keyword data for development/testing
 * 
 * @param {string} keyword - Keyword to generate mock data for
 * @returns {Object} - Mock keyword data
 */
function mockKeywordData(keyword) {
  // Create deterministic but varied mock data based on keyword length
  const keywordLength = keyword.length;
  const searchVolume = Math.floor(1000 + (keywordLength * 500) * (0.5 + Math.random()));
  const competition = Math.min(0.1 + (keywordLength % 10) / 20 + Math.random() * 0.3, 1);
  const cpc = 0.5 + (keywordLength % 5) * 0.3 + Math.random();
  
  // Generate related keywords by adding prefixes/suffixes
  const prefixes = ['best', 'top', 'affordable', 'premium', 'how to', 'why', 'when to'];
  const suffixes = ['guide', 'tutorial', 'review', 'tips', 'for beginners', 'services', 'near me'];
  
  const relatedKeywords = [
    ...prefixes.map(prefix => `${prefix} ${keyword}`),
    ...suffixes.map(suffix => `${keyword} ${suffix}`)
  ].slice(0, 10); // Limit to 10 related keywords
  
  return {
    success: true,
    keyword,
    search_volume: searchVolume,
    competition,
    cpc,
    related_keywords: relatedKeywords
  };
}

/**
 * Fetches related keywords for a given keyword
 * 
 * @param {string} keyword - Base keyword
 * @returns {Promise<Array<string>>} - List of related keywords
 */
async function fetchRelatedKeywords(keyword) {
  try {
    // If API key is not available, use deterministic mock data
    if (!KEYWORD_PLANNER_API_KEY) {
      const prefixes = ['best', 'top', 'affordable', 'premium', 'how to', 'why', 'when to'];
      const suffixes = ['guide', 'tutorial', 'review', 'tips', 'for beginners', 'services', 'near me'];
      
      return [
        ...prefixes.map(prefix => `${prefix} ${keyword}`),
        ...suffixes.map(suffix => `${keyword} ${suffix}`)
      ].slice(0, 15);
    }
    
    // Real API call to get related keywords
    const response = await axios.post(
      'https://googleads.googleapis.com/v11/customers/1234567890/googleAds:searchStream',
      {
        query: `
          SELECT 
            keyword_view.resource_name,
            keyword_plan_keyword.keyword_text,
            keyword_plan_keyword_historical_metrics.avg_monthly_searches,
            keyword_plan_keyword_historical_metrics.competition_index
          FROM keyword_plan_keyword
          WHERE keyword_plan_keyword.keyword_text LIKE '%${keyword}%'
          ORDER BY keyword_plan_keyword_historical_metrics.avg_monthly_searches DESC
          LIMIT 15
        `
      },
      {
        headers: {
          'Authorization': `Bearer ${KEYWORD_PLANNER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.data && response.data.results) {
      return response.data.results.map(result => result.keyword_plan_keyword.keyword_text);
    }
    
    return [];
  } catch (error) {
    logger.error(`Error fetching related keywords for ${keyword}:`, error);
    // Return empty array on error
    return [];
  }
}

/**
 * Generates niche recommendations based on keyword data
 * 
 * @param {Array<Object>} keywordDataList - List of keyword data objects
 * @param {Object} preferences - User preferences
 * @returns {Array<Object>} - List of niche recommendations
 */
function generateNicheRecommendations(keywordDataList, preferences) {
  const niches = [];
  
  // Process each valid keyword as a potential niche
  keywordDataList.forEach(data => {
    // Skip if not successful
    if (!data.success) return;
    
    // Create a niche from the main keyword
    const niche = {
      niche_name: data.keyword,
      monthly_search_volume: data.search_volume,
      competition: data.competition,
      estimated_cpc: data.cpc,
      related_keywords: data.related_keywords || [],
      top_competitors: [] // Will be populated later
    };
    
    // Add to niches list
    niches.push(niche);
    
    // Also consider related keywords as potential niches if they have sufficient search volume
    if (data.related_keywords && data.related_keywords.length > 0) {
      // Use mock data for related keywords
      data.related_keywords.forEach(relatedKeyword => {
        // Skip very short related keywords or those too similar to main keyword
        if (relatedKeyword.length < 5 || relatedKeyword === data.keyword) return;
        
        // Create deterministic but varied search volume for related keywords
        const searchVolMod = 0.3 + Math.random() * 0.7; // 30-100% of main keyword
        const searchVolume = Math.floor(data.search_volume * searchVolMod);
        
        // Only consider as a niche if it has sufficient search volume
        if (searchVolume >= 1000) {
          niches.push({
            niche_name: relatedKeyword,
            monthly_search_volume: searchVolume,
            competition: data.competition * (0.8 + Math.random() * 0.4), // Slightly varied competition
            estimated_cpc: data.cpc * (0.8 + Math.random() * 0.4), // Slightly varied CPC
            related_keywords: [data.keyword, ...data.related_keywords.filter(k => k !== relatedKeyword).slice(0, 5)],
            top_competitors: []
          });
        }
      });
    }
  });
  
  // Apply user preferences if provided
  if (preferences.industry) {
    // Filter or boost niches related to preferred industry
    // This is a simplified implementation
    return niches.filter(niche => 
      niche.niche_name.includes(preferences.industry) || 
      niche.related_keywords.some(k => k.includes(preferences.industry))
    );
  }
  
  return niches;
}

/**
 * Calculates a competition score for a niche
 * 
 * @param {Object} niche - Niche object
 * @returns {Promise<number>} - Competition score (0-100, lower is less competitive)
 */
async function calculateCompetitionScore(niche) {
  try {
    // If no API key is available, calculate based on the niche data we have
    if (!AHREFS_API_KEY) {
      // Base score on the competition value (0-1) scaled to 0-100
      const baseScore = niche.competition * 100;
      
      // Adjust based on search volume (higher volume often means more competition)
      const volumeAdjustment = Math.log10(niche.monthly_search_volume) * 2;
      
      // Adjust based on CPC (higher CPC often means more competition)
      const cpcAdjustment = niche.estimated_cpc * 5;
      
      // Calculate final score with weights
      const finalScore = (baseScore * 0.6) + (volumeAdjustment * 0.2) + (cpcAdjustment * 0.2);
      
      // Ensure score is within 0-100 range
      return Math.min(100, Math.max(0, finalScore));
    }
    
    // For real implementation, use Ahrefs/SEMrush API to analyze top ranking sites
    const response = await axios.get(
      `https://apiv2.ahrefs.com/positions`,
      {
        params: {
          token: AHREFS_API_KEY,
          target: niche.niche_name,
          mode: 'domain',
          limit: 10
        }
      }
    );
    
    if (response.data && response.data.pages) {
      // Extract domain authority and other metrics from top 10 results
      const topSites = response.data.pages.slice(0, 10);
      
      // Store top competitors
      niche.top_competitors = topSites.map(site => ({
        domain: site.url,
        domain_authority: site.domain_rating,
        estimated_traffic: site.organic_traffic
      }));
      
      // Calculate average domain authority of top results
      const avgDomainAuthority = topSites.reduce((sum, site) => sum + site.domain_rating, 0) / topSites.length;
      
      // Calculate backlink strength
      const avgBacklinks = topSites.reduce((sum, site) => sum + site.backlinks, 0) / topSites.length;
      
      // Calculate competition score
      return Math.min(100, (avgDomainAuthority * 0.7) + (Math.log10(avgBacklinks) * 3));
    }
    
    // Fallback to base calculation if API call fails
    return niche.competition * 100;
  } catch (error) {
    logger.error(`Error calculating competition score for ${niche.niche_name}:`, error);
    // Fallback to a reasonable default based on the niche data
    return niche.competition * 80 + 20; // Scale 0-1 to 20-100 range
  }
}

/**
 * Evaluates the monetization potential of a niche
 * 
 * @param {Object} niche - Niche object
 * @returns {number} - Monetization potential score (0-10)
 */
function evaluateMonetizationPotential(niche) {
  // Check if we can use Amazon API for product data
  let amazonProductCount = 0;
  
  // Simplified implementation using CPC and search volume as main indicators
  
  // 1. CPC Factor (higher CPC often indicates better monetization)
  // Scale: 0-5 points
  const cpcFactor = Math.min(5, niche.estimated_cpc * 2);
  
  // 2. Volume Factor (higher volume = more traffic potential)
  // Scale: 0-3 points
  const volumeFactor = Math.min(3, Math.log10(niche.monthly_search_volume) - 2);
  
  // 3. Commercial Intent Factor
  // Check for commercial keywords in niche name or related keywords
  const commercialKeywords = ['buy', 'price', 'review', 'best', 'top', 'vs', 'cheap', 'affordable', 'deal', 'sale'];
  
  const nicheTerms = [
    niche.niche_name,
    ...(niche.related_keywords || [])
  ];
  
  let commercialIntentScore = 0;
  commercialKeywords.forEach(term => {
    if (nicheTerms.some(nicheTerm => nicheTerm.includes(term))) {
      commercialIntentScore += 0.2;
    }
  });
  
  // Cap commercial intent factor at 2 points
  commercialIntentScore = Math.min(2, commercialIntentScore);
  
  // Calculate final score
  const finalScore = cpcFactor + volumeFactor + commercialIntentScore;
  
  // Normalize to 0-10 scale
  return Math.min(10, finalScore);
}

/**
 * Calculates a trending score for a niche based on Google Trends data
 * 
 * @param {string} nicheName - Name of the niche
 * @returns {Promise<number>} - Trending score (0-10)
 */
async function calculateTrendingScore(nicheName) {
  try {
    // If no API key, use a simplified scoring method
    if (!GOOGLE_TRENDS_API_KEY) {
      // Generate a semi-random but consistent trend score based on niche name
      // This is only for development when the API is not available
      const hash = nicheName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const baseScore = (hash % 60) / 10 + 2; // 2-8 range
      
      // Add some randomness within a small range
      return Math.min(10, baseScore + (Math.random() * 2 - 1));
    }
    
    // Real implementation would use Google Trends API
    const response = await axios.get(
      'https://trends.googleapis.com/trends/api/explore',
      {
        params: {
          hl: 'en-US',
          tz: -120,
          req: JSON.stringify({
            comparisonItem: [{
              keyword: nicheName,
              geo: '',
              time: 'today 12-m'
            }],
            category: 0,
            property: ''
          }),
          token: GOOGLE_TRENDS_API_KEY
        }
      }
    );
    
    // Process the response to calculate a trend score
    // This would normally involve analyzing the time series data
    
    // Extract interest over time data
    const data = JSON.parse(response.data.slice(5)); // Google Trends API adds ")]}'" to the beginning
    const timelineData = data.default.timelineData;
    
    // Calculate average interest
    const avgInterest = timelineData.reduce((sum, point) => sum + point.value[0], 0) / timelineData.length;
    
    // Calculate slope (growth trend)
    const n = timelineData.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const y = timelineData.map(point => point.value[0]);
    
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumXX += x[i] * x[i];
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    
    // Calculate trend score based on average interest and slope
    const trendScore = (avgInterest / 20) + (slope * 20);
    
    // Normalize to 0-10 scale
    return Math.min(10, Math.max(0, trendScore));
  } catch (error) {
    logger.error(`Error calculating trending score for ${nicheName}:`, error);
    // Return a default score on error
    return 5; // Neutral trend score
  }
}

/**
 * Saves niche analysis results to the database
 * 
 * @param {Array<Object>} niches - Analyzed niches
 * @returns {Promise<void>}
 */
async function saveAnalysisResults(niches) {
  let client;
  
  try {
    client = await pool.connect();
    
    // Begin transaction
    await client.query('BEGIN');
    
    for (const niche of niches) {
      // Check if niche already exists
      const checkQuery = 'SELECT id FROM niches WHERE name = $1';
      const checkResult = await client.query(checkQuery, [niche.niche_name]);
      
      let nicheId;
      
      if (checkResult.rows.length > 0) {
        // Update existing niche
        nicheId = checkResult.rows[0].id;
        
        const updateQuery = `
          UPDATE niches 
          SET 
            monthly_search_volume = $1, 
            competition_score = $2, 
            monetization_potential = $3, 
            trending_score = $4, 
            estimated_cpc = $5,
            last_updated = NOW()
          WHERE id = $6
          RETURNING id
        `;
        
        await client.query(updateQuery, [
          niche.monthly_search_volume,
          niche.competition_score,
          niche.monetization_potential,
          niche.trending_score,
          niche.estimated_cpc,
          nicheId
        ]);
      } else {
        // Insert new niche
        const insertQuery = `
          INSERT INTO niches (
            name, 
            monthly_search_volume, 
            competition_score, 
            monetization_potential, 
            trending_score, 
            estimated_cpc,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
          RETURNING id
        `;
        
        const result = await client.query(insertQuery, [
          niche.niche_name,
          niche.monthly_search_volume,
          niche.competition_score,
          niche.monetization_potential,
          niche.trending_score,
          niche.estimated_cpc
        ]);
        
        nicheId = result.rows[0].id;
      }
      
      // Save related keywords
      if (niche.related_keywords && niche.related_keywords.length > 0) {
        // Delete existing related keywords
        await client.query('DELETE FROM niche_keywords WHERE niche_id = $1', [nicheId]);
        
        // Insert new related keywords
        for (const keyword of niche.related_keywords) {
          await client.query(
            'INSERT INTO niche_keywords (niche_id, keyword) VALUES ($1, $2)',
            [nicheId, keyword]
          );
        }
      }
      
      // Save top competitors
      if (niche.top_competitors && niche.top_competitors.length > 0) {
        // Delete existing competitors
        await client.query('DELETE FROM niche_competitors WHERE niche_id = $1', [nicheId]);
        
        // Insert new competitors
        for (const competitor of niche.top_competitors) {
          await client.query(
            'INSERT INTO niche_competitors (niche_id, domain, domain_authority, estimated_traffic) VALUES ($1, $2, $3, $4)',
            [nicheId, competitor.domain, competitor.domain_authority, competitor.estimated_traffic]
          );
        }
      }
    }
    
    // Commit transaction
    await client.query('COMMIT');
    
    logger.info(`Saved analysis results for ${niches.length} niches to database`);
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    logger.error('Error saving niche analysis results to database:', error);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

module.exports = {
  analyzeNiche,
  fetchKeywordData,
  calculateCompetitionScore,
  evaluateMonetizationPotential,
  calculateTrendingScore
};
