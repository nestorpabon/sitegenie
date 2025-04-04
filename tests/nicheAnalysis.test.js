/**
 * Tests for the Niche Analysis module
 */
const axios = require('axios');
const { Pool } = require('pg');
const { 
  analyzeNiche,
  fetchKeywordData, 
  calculateCompetitionScore, 
  evaluateMonetizationPotential,
  calculateTrendingScore
} = require('../src/nicheAnalysis');

// Mock dependencies
jest.mock('axios');
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

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

describe('Niche Analysis Module', () => {
  let mockPool;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset environment variables
    process.env.KEYWORD_PLANNER_API_KEY = '';
    process.env.AHREFS_API_KEY = '';
    process.env.AMAZON_API_KEY = '';
    process.env.GOOGLE_TRENDS_API_KEY = '';
    
    // Get references to mocked instances
    mockPool = new Pool();
    mockClient = mockPool.connect();
  });

  describe('analyzeNiche', () => {
    test('should successfully analyze niches based on keywords', async () => {
      // Mock fetchKeywordData to return successful responses
      const mockKeyword1 = 'hydroponics';
      const mockKeyword2 = 'gardening';
      
      // Setup axios mock for successful responses
      axios.post.mockImplementation(() => {
        return Promise.resolve({
          data: {
            results: [
              {
                keyword_plan_keyword: { keyword_text: mockKeyword1 },
                keyword_plan_keyword_historical_metrics: {
                  avg_monthly_searches: 5000,
                  competition_index: 35,
                  high_top_of_page_bid_micros: 1500000
                }
              }
            ]
          }
        });
      });
      
      axios.get.mockImplementation(() => {
        return Promise.resolve({
          data: {
            pages: [
              { 
                url: 'example.com', 
                domain_rating: 45, 
                organic_traffic: 30000,
                backlinks: 5000 
              },
              { 
                url: 'competitor.com', 
                domain_rating: 52, 
                organic_traffic: 45000,
                backlinks: 7500 
              }
            ]
          }
        });
      });
      
      // Execute
      const result = await analyzeNiche({
        keywords: [mockKeyword1, mockKeyword2],
        limit: 2
      });
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.niche_recommendations).toBeDefined();
      expect(result.niche_recommendations.length).toBeLessThanOrEqual(2);
      
      // Check that each recommendation has the expected fields
      result.niche_recommendations.forEach(niche => {
        expect(niche.niche_name).toBeDefined();
        expect(niche.competition_score).toBeDefined();
        expect(niche.monetization_potential).toBeDefined();
        expect(niche.trending_score).toBeDefined();
      });
    });

    test('should handle empty keywords array', async () => {
      // Execute
      const result = await analyzeNiche({
        keywords: [],
        limit: 5
      });
      
      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('No keywords provided');
    });

    test('should handle failed keyword data lookups', async () => {
      // Mock axios to fail on all requests
      axios.post.mockRejectedValue(new Error('API request failed'));
      axios.get.mockRejectedValue(new Error('API request failed'));
      
      // Execute with valid keywords but API failures
      const result = await analyzeNiche({
        keywords: ['hydroponics', 'gardening'],
        limit: 5
      });
      
      // In this case, we're expecting success because the function uses mock data as fallback
      expect(result.success).toBe(true);
      expect(result.niche_recommendations).toBeDefined();
      
      // Or if the implementation strictly requires real data:
      // expect(result.success).toBe(false);
      // expect(result.error).toContain('Failed to retrieve valid data');
    });

    test('should apply user preferences when provided', async () => {
      // Mock fetchKeywordData to return successful responses
      const mockKeywords = ['hydroponics', 'organic gardening', 'indoor plants'];
      
      // Setup axios mock for successful responses
      axios.post.mockImplementation(() => {
        return Promise.resolve({
          data: {
            results: [
              {
                keyword_plan_keyword: { keyword_text: 'hydroponics' },
                keyword_plan_keyword_historical_metrics: {
                  avg_monthly_searches: 5000,
                  competition_index: 35,
                  high_top_of_page_bid_micros: 1500000
                }
              }
            ]
          }
        });
      });
      
      // Execute with preferences
      const result = await analyzeNiche({
        keywords: mockKeywords,
        preferences: {
          industry: 'organic'
        },
        limit: 5
      });
      
      // Assert that preferences are applied
      expect(result.success).toBe(true);
      
      // Check that at least one recommendation relates to the preferred industry
      if (result.niche_recommendations.length > 0) {
        const hasRelevantNiche = result.niche_recommendations.some(
          niche => niche.niche_name.includes('organic')
        );
        
        expect(hasRelevantNiche).toBe(true);
      }
    });
  });

  describe('fetchKeywordData', () => {
    test('should fetch keyword data successfully', async () => {
      // Mock successful API response
      process.env.KEYWORD_PLANNER_API_KEY = 'fake-api-key';
      
      const mockKeyword = 'hydroponics';
      const mockApiResponse = {
        data: {
          results: [
            {
              keyword_plan_keyword: { keyword_text: mockKeyword },
              keyword_plan_keyword_historical_metrics: {
                avg_monthly_searches: 10000,
                competition_index: 45,
                high_top_of_page_bid_micros: 2000000
              }
            }
          ]
        }
      };
      
      axios.post.mockResolvedValueOnce(mockApiResponse);
      
      // Mock related keywords API call
      axios.post.mockResolvedValueOnce({
        data: {
          results: [
            { keyword_plan_keyword: { keyword_text: 'indoor hydroponics' } },
            { keyword_plan_keyword: { keyword_text: 'hydroponic gardens' } }
          ]
        }
      });
      
      // Execute
      const result = await fetchKeywordData(mockKeyword);
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.keyword).toBe(mockKeyword);
      expect(result.search_volume).toBe(10000);
      expect(result.competition).toBe(0.45); // Normalized from 45
      expect(result.cpc).toBe(2); // Converted from micros
      expect(result.related_keywords).toBeDefined();
      expect(result.related_keywords.length).toBeGreaterThan(0);
    });

    test('should use mock data when API key is not available', async () => {
      // Ensure API key is not set
      process.env.KEYWORD_PLANNER_API_KEY = '';
      
      // Execute
      const result = await fetchKeywordData('hydroponics');
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.keyword).toBe('hydroponics');
      expect(result.search_volume).toBeDefined();
      expect(result.competition).toBeDefined();
      expect(result.cpc).toBeDefined();
      expect(result.related_keywords).toBeDefined();
    });

    test('should handle API errors gracefully', async () => {
      // Set API key but mock API failure
      process.env.KEYWORD_PLANNER_API_KEY = 'fake-api-key';
      axios.post.mockRejectedValueOnce(new Error('API request failed'));
      
      // Execute
      const result = await fetchKeywordData('hydroponics');
      
      // Should fall back to mock data
      expect(result.success).toBe(true);
      expect(result.keyword).toBe('hydroponics');
      expect(result.search_volume).toBeDefined();
    });

    test('should handle empty API response', async () => {
      // Set API key but mock empty response
      process.env.KEYWORD_PLANNER_API_KEY = 'fake-api-key';
      axios.post.mockResolvedValueOnce({
        data: { results: [] }
      });
      
      // Execute
      const result = await fetchKeywordData('very-obscure-keyword-with-no-data');
      
      // Should fall back to mock data
      expect(result.success).toBe(true);
      expect(result.keyword).toBe('very-obscure-keyword-with-no-data');
      expect(result.search_volume).toBeDefined();
    });
  });

  describe('calculateCompetitionScore', () => {
    test('should calculate competition score using real API when available', async () => {
      // Set API key
      process.env.AHREFS_API_KEY = 'fake-ahrefs-key';
      
      // Mock niche data
      const niche = {
        niche_name: 'hydroponics',
        monthly_search_volume: 10000,
        competition: 0.35,
        estimated_cpc: 1.5,
        top_competitors: []
      };
      
      // Mock Ahrefs API response
      axios.get.mockResolvedValueOnce({
        data: {
          pages: [
            { url: 'example.com', domain_rating: 45, organic_traffic: 30000, backlinks: 5000 },
            { url: 'competitor.com', domain_rating: 52, organic_traffic: 45000, backlinks: 7500 }
          ]
        }
      });
      
      // Execute
      const score = await calculateCompetitionScore(niche);
      
      // Assert
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
      expect(niche.top_competitors.length).toBeGreaterThan(0);
    });

    test('should calculate competition score using fallback when API not available', async () => {
      // Ensure API key is not set
      process.env.AHREFS_API_KEY = '';
      
      // Mock niche data
      const niche = {
        niche_name: 'hydroponics',
        monthly_search_volume: 10000,
        competition: 0.35,
        estimated_cpc: 1.5
      };
      
      // Execute
      const score = await calculateCompetitionScore(niche);
      
      // Assert
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    test('should handle API errors', async () => {
      // Set API key but mock API failure
      process.env.AHREFS_API_KEY = 'fake-ahrefs-key';
      axios.get.mockRejectedValueOnce(new Error('API request failed'));
      
      // Mock niche data
      const niche = {
        niche_name: 'hydroponics',
        monthly_search_volume: 10000,
        competition: 0.35,
        estimated_cpc: 1.5
      };
      
      // Execute
      const score = await calculateCompetitionScore(niche);
      
      // Should calculate score using fallback method
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  describe('evaluateMonetizationPotential', () => {
    test('should evaluate monetization potential based on niche data', () => {
      // Mock niche with good monetization indicators
      const goodNiche = {
        niche_name: 'best hydroponics systems',
        monthly_search_volume: 15000,
        competition: 0.3,
        estimated_cpc: 2.5,
        related_keywords: ['buy hydroponics', 'hydroponics price', 'top hydroponics kits']
      };
      
      // Mock niche with poor monetization indicators
      const poorNiche = {
        niche_name: 'what is hydroponics',
        monthly_search_volume: 8000,
        competition: 0.2,
        estimated_cpc: 0.8,
        related_keywords: ['hydroponics definition', 'hydroponics explained', 'history of hydroponics']
      };
      
      // Execute
      const goodScore = evaluateMonetizationPotential(goodNiche);
      const poorScore = evaluateMonetizationPotential(poorNiche);
      
      // Assert
      expect(goodScore).toBeGreaterThan(poorScore);
      expect(goodScore).toBeGreaterThan(5); // Good monetization potential
      expect(poorScore).toBeLessThan(goodScore);
      
      // Validate score range
      expect(goodScore).toBeGreaterThanOrEqual(0);
      expect(goodScore).toBeLessThanOrEqual(10);
      expect(poorScore).toBeGreaterThanOrEqual(0);
      expect(poorScore).toBeLessThanOrEqual(10);
    });

    test('should handle niches with missing data', () => {
      // Mock niche with missing data
      const incompleteNiche = {
        niche_name: 'hydroponics',
        // Missing other fields
      };
      
      // Execute
      const score = evaluateMonetizationPotential(incompleteNiche);
      
      // Assert - should not crash and return a valid score
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(10);
    });
  });

  describe('calculateTrendingScore', () => {
    test('should calculate trending score using Google Trends API when available', async () => {
      // Set API key
      process.env.GOOGLE_TRENDS_API_KEY = 'fake-trends-key';
      
      // Mock Google Trends API response
      axios.get.mockResolvedValueOnce({
        data: `)]}'\n` + // Google Trends API prefix
          JSON.stringify({
            default: {
              timelineData: [
                { value: [60] },
                { value: [65] },
                { value: [70] },
                { value: [75] },
                { value: [80] }
              ]
            }
          })
      });
      
      // Execute
      const score = await calculateTrendingScore('hydroponics');
      
      // Assert
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(10);
    });

    test('should use fallback when API key is not available', async () => {
      // Ensure API key is not set
      process.env.GOOGLE_TRENDS_API_KEY = '';
      
      // Execute
      const score = await calculateTrendingScore('hydroponics');
      
      // Assert
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(10);
    });

    test('should handle API errors', async () => {
      // Set API key but mock API failure
      process.env.GOOGLE_TRENDS_API_KEY = 'fake-trends-key';
      axios.get.mockRejectedValueOnce(new Error('API request failed'));
      
      // Execute
      const score = await calculateTrendingScore('hydroponics');
      
      // Should return a default score
      expect(score).toBe(5);
    });

    test('should return consistent results for the same niche name', async () => {
      // Ensure API key is not set to use deterministic mock data
      process.env.GOOGLE_TRENDS_API_KEY = '';
      
      // Execute multiple times for the same niche
      const score1 = await calculateTrendingScore('hydroponics');
      const score2 = await calculateTrendingScore('hydroponics');
      
      // Assert
      expect(score1).toBe(score2);
    });
  });

  describe('End-to-end analysis flow', () => {
    test('should complete the full niche analysis workflow', async () => {
      // Setup environment and mocks for a complete workflow
      process.env.SAVE_ANALYSIS_RESULTS = 'true';
      
      // Mock client query for database operations
      mockClient.query.mockResolvedValue({ rows: [] });
      
      // Mock keyword data API call
      axios.post.mockResolvedValue({
        data: {
          results: [
            {
              keyword_plan_keyword: { keyword_text: 'hydroponics' },
              keyword_plan_keyword_historical_metrics: {
                avg_monthly_searches: 10000,
                competition_index: 45,
                high_top_of_page_bid_micros: 2000000
              }
            }
          ]
        }
      });
      
      // Mock competitors data API call
      axios.get.mockResolvedValue({
        data: {
          pages: [
            { url: 'example.com', domain_rating: 45, organic_traffic: 30000, backlinks: 5000 }
          ]
        }
      });
      
      // Execute a full analysis
      const result = await analyzeNiche({
        keywords: ['hydroponics', 'gardening'],
        limit: 3,
        includeKeywordData: true
      });
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.niche_recommendations.length).toBeGreaterThan(0);
      expect(result.keyword_data).toBeDefined();
      
      // Verify database operations were attempted for saving results
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    test('should handle database errors when saving results', async () => {
      // Setup environment and mocks
      process.env.SAVE_ANALYSIS_RESULTS = 'true';
      
      // Mock successful API calls
      axios.post.mockResolvedValue({
        data: {
          results: [
            {
              keyword_plan_keyword: { keyword_text: 'hydroponics' },
              keyword_plan_keyword_historical_metrics: {
                avg_monthly_searches: 10000,
                competition_index: 45,
                high_top_of_page_bid_micros: 2000000
              }
            }
          ]
        }
      });
      
      // But mock a database error
      mockClient.query.mockImplementation(query => {
        if (query === 'BEGIN') {
          return Promise.resolve();
        } else {
          return Promise.reject(new Error('Database error'));
        }
      });
      
      // Execute
      const result = await analyzeNiche({
        keywords: ['hydroponics'],
        limit: 2
      });
      
      // Assert - analysis should still complete, with database rollback
      expect(result.success).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });
});
